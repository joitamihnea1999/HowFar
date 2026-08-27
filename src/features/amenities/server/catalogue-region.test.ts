import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { findActive } = vi.hoisted(() => ({ findActive: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: () => ({ amenityDataset: { findUnique: findActive } }),
}));

import {
  activeDatasetRegionOk,
  datasetMatchesExtent,
  describeRegionMismatch,
  readValidationBbox,
} from "./catalogue-region";

// The default resolved extent (no NEXT_PUBLIC_MAP_BBOX set) is the Bucharest box.
const DEFAULT = { minLng: 25.8, minLat: 44.2, maxLng: 26.4, maxLat: 44.7 };
const OTHER_CITY = { minLng: 23.4, minLat: 46.6, maxLng: 23.7, maxLat: 46.9 };
const validationWith = (bbox: unknown) => ({ source: { bbox } });

beforeEach(() => findActive.mockReset());
afterEach(() => vi.unstubAllEnvs());

describe("readValidationBbox — tri-state (absent / malformed / Bbox)", () => {
  it("returns the Bbox when present and valid", () => {
    expect(readValidationBbox(validationWith(DEFAULT))).toEqual(DEFAULT);
  });

  it("'absent' for a well-formed legacy shape missing source/bbox (pre-007), or undefined", () => {
    expect(readValidationBbox(undefined)).toBe("absent");
    expect(readValidationBbox({})).toBe("absent");
    expect(readValidationBbox({ source: {} })).toBe("absent");
    expect(readValidationBbox({ source: { bbox: undefined } })).toBe("absent");
  });

  it("'malformed' when the bbox KEY is present but not a valid box", () => {
    expect(readValidationBbox(validationWith(null))).toBe("malformed");
    expect(readValidationBbox(validationWith({ minLng: "25.8", minLat: 44.2, maxLng: 26.4, maxLat: 44.7 }))).toBe("malformed");
    expect(readValidationBbox(validationWith({ minLng: 25.8, minLat: 44.2, maxLng: 26.4 }))).toBe("malformed");
    expect(readValidationBbox(validationWith({ minLng: Number.NaN, minLat: 44.2, maxLng: 26.4, maxLat: 44.7 }))).toBe("malformed");
  });

  it("'malformed' when `source` is PRESENT but not a plain object (null/array/string/number) — corruption, not legacy", () => {
    expect(readValidationBbox({ source: null })).toBe("malformed");
    expect(readValidationBbox({ source: "x" })).toBe("malformed");
    expect(readValidationBbox({ source: 42 })).toBe("malformed");
    expect(readValidationBbox({ source: [1, 2] })).toBe("malformed");
  });

  it("'malformed' when the `validation` ROOT itself is a non-plain-object (JSONB null / array / primitive)", () => {
    // Same fail-closed rule at the top level as for `source` — a corrupt root must
    // never be grandfathered as legacy.
    expect(readValidationBbox(null)).toBe("malformed");
    expect(readValidationBbox("garbage")).toBe("malformed");
    expect(readValidationBbox(42)).toBe("malformed");
    expect(readValidationBbox([1, 2, 3])).toBe("malformed");
    expect(readValidationBbox(true)).toBe("malformed");
  });

  it("all malformed shapes (root OR source OR bbox) FAIL CLOSED via datasetMatchesExtent under the default extent", () => {
    for (const v of [null, "garbage", 42, [1, 2, 3], { source: null }, { source: "x" }, { source: [1] }, validationWith(null)]) {
      expect(datasetMatchesExtent(v)).toBe(false);
    }
  });
});

describe("datasetMatchesExtent — under the DEFAULT extent", () => {
  it("matches a dataset whose recorded bbox equals the extent", () => {
    expect(datasetMatchesExtent(validationWith(DEFAULT))).toBe(true);
  });

  it("does NOT match a dataset recorded for another city (the extent-flip hazard)", () => {
    expect(datasetMatchesExtent(validationWith(OTHER_CITY))).toBe(false);
  });

  it("GRANDFATHERS a legacy dataset with no recorded bbox (pre-007) under the default extent", () => {
    // undefined validation / missing bbox ⇒ trusted only because the extent is default
    expect(datasetMatchesExtent(undefined)).toBe(true);
    expect(datasetMatchesExtent({})).toBe(true);
    expect(datasetMatchesExtent(validationWith(undefined))).toBe(true);
  });

  it("FAILS CLOSED on a malformed (present-but-unparseable) bbox even under the default extent — a corrupt box is NOT the legacy path", () => {
    expect(datasetMatchesExtent(validationWith(null))).toBe(false);
    expect(datasetMatchesExtent(validationWith({ minLng: "25.8", minLat: 44.2, maxLng: 26.4, maxLat: 44.7 }))).toBe(false);
    expect(datasetMatchesExtent(validationWith({ minLng: 25.8, minLat: 44.2, maxLng: 26.4 }))).toBe(false);
  });
});

describe("datasetMatchesExtent — under a FLIPPED extent (deploy-ordering)", () => {
  async function reimport() {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_MAP_BBOX", "23.4,46.6,23.7,46.9");
    return import("./catalogue-region");
  }

  it("matches only the new city's dataset; fails a legacy (no-bbox) OR old-city dataset", async () => {
    const mod = await reimport();
    expect(mod.datasetMatchesExtent(validationWith(OTHER_CITY))).toBe(true); // new city present ⇒ match
    expect(mod.datasetMatchesExtent(validationWith(DEFAULT))).toBe(false); // old city present ⇒ fail closed
    expect(mod.datasetMatchesExtent(undefined)).toBe(false); // legacy, unprovable ⇒ fail closed
    expect(mod.datasetMatchesExtent({})).toBe(false);
  });
});

describe("describeRegionMismatch", () => {
  it("names both the configured extent and the recorded box", () => {
    const msg = describeRegionMismatch(validationWith(OTHER_CITY));
    expect(msg).toContain("[25.8,44.2,26.4,44.7]"); // configured (default)
    expect(msg).toContain("[23.4,46.6,23.7,46.9]"); // recorded
  });

  it("says 'none' for a legacy dataset with no recorded bbox", () => {
    expect(describeRegionMismatch(undefined)).toContain("none");
  });

  it("says 'malformed' for a present-but-unparseable bbox", () => {
    expect(describeRegionMismatch(validationWith({ minLng: "x" }))).toContain("malformed");
  });
});

describe("activeDatasetRegionOk", () => {
  it("no active dataset ⇒ hasActive:false, matches:true (readiness unaffected)", async () => {
    findActive.mockResolvedValue(null);
    await expect(activeDatasetRegionOk()).resolves.toEqual({ hasActive: false, matches: true });
  });

  it("active dataset matching the extent ⇒ matches:true, and selects validation", async () => {
    findActive.mockResolvedValue({ validation: validationWith(DEFAULT) });
    await expect(activeDatasetRegionOk()).resolves.toMatchObject({ hasActive: true, matches: true });
    // Pin the select so a future edit can't drop `validation` and silently fail open.
    expect(findActive).toHaveBeenCalledWith(
      expect.objectContaining({ select: expect.objectContaining({ validation: true }) }),
    );
  });

  it("active dataset for another city ⇒ matches:false (and returns validation for logging)", async () => {
    findActive.mockResolvedValue({ validation: validationWith(OTHER_CITY) });
    const result = await activeDatasetRegionOk();
    expect(result).toMatchObject({ hasActive: true, matches: false });
    expect(result.validation).toEqual(validationWith(OTHER_CITY));
  });

  // NB: `activeDatasetRegionOk` deliberately does NOT catch a query error — it
  // propagates, and the /api/ready route turns that into a fail-closed 503. That
  // propagation-to-503 path is asserted in `ready/route.test.ts` ("503 when the
  // region query itself throws"), where the route's own try/catch handles the
  // rejection; asserting it directly here trips a vitest spy unhandled-rejection
  // quirk without adding coverage, so it lives at the consumer.
});
