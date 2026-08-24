import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { providerFetch } = vi.hoisted(() => ({ providerFetch: vi.fn() }));
vi.mock("@/lib/provider-http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/provider-http")>()),
  providerFetch,
}));

import { raceOverpass } from "./overpass-client";

const el = { type: "relation", tags: { type: "route", route: "bus", ref: "1", to: "X" } };
const resp = (elements: unknown, remark?: string, ok = true, status = 200) => ({
  ok,
  status,
  json: () => Promise.resolve({ elements, remark }),
});

beforeEach(() => providerFetch.mockReset());

describe("raceOverpass — empty semantics", () => {
  it("default (treatEmptyAsFailure:true): all-empty → ProviderError (amenity behavior unchanged)", async () => {
    providerFetch.mockResolvedValue(resp([]));
    await expect(raceOverpass("q")).rejects.toThrow(/overpass unavailable/i);
  });

  it("tolerated empty (false): all-empty resolves to [] instead of throwing (task 021)", async () => {
    providerFetch.mockResolvedValue(resp([]));
    await expect(raceOverpass("q", { treatEmptyAsFailure: false })).resolves.toEqual([]);
    expect(providerFetch).toHaveBeenCalledTimes(3);
  });

  it("PREFERS a non-empty host over a fast empty one — the degraded-mirror [] never wins", async () => {
    providerFetch
      .mockResolvedValueOnce(resp([])) // degraded mirror: instant empty
      .mockResolvedValueOnce(resp([el])) // healthy host: real routes
      .mockRejectedValueOnce(new TypeError("down")); // third host errors
    const out = await raceOverpass("q", { treatEmptyAsFailure: false });
    expect(out).toEqual([el]); // real routes win, NOT []
  });

  it("resolves [] when hosts are empty-or-errored with at least one empty", async () => {
    providerFetch
      .mockResolvedValueOnce(resp([])) // empty
      .mockRejectedValueOnce(new TypeError("down"))
      .mockResolvedValueOnce(resp([], "runtime error: Query timed out")); // soft-remark fail
    await expect(raceOverpass("q", { treatEmptyAsFailure: false })).resolves.toEqual([]);
  });

  it("throws ProviderError when EVERY host errors and none returned an empty envelope", async () => {
    providerFetch
      .mockRejectedValueOnce(new TypeError("network down 1"))
      .mockRejectedValueOnce(new TypeError("network down 2"))
      .mockRejectedValueOnce(new TypeError("network down 3"));
    await expect(raceOverpass("q", { treatEmptyAsFailure: false })).rejects.toThrow(/overpass unavailable/i);
  });
});

describe("config-driven endpoint pool (task 007)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("defaults to today's 3-host pool, deriving rateHost from each URL", async () => {
    providerFetch.mockResolvedValue(resp([el]));
    await raceOverpass("q", { treatEmptyAsFailure: false });
    const urls = providerFetch.mock.calls.map((c) => c[0] as string);
    expect(urls).toEqual([
      "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
      "https://overpass-api.de/api/interpreter",
      "https://overpass.kumi.systems/api/interpreter",
    ]);
    const hosts = providerFetch.mock.calls.map((c) => (c[1] as { rateHost: string }).rateHost);
    expect(hosts).toEqual(["maps.mail.ru", "overpass-api.de", "overpass.kumi.systems"]);
  });

  it("uses an OVERPASS_ENDPOINTS override (URL + derived rateHost)", async () => {
    vi.stubEnv("OVERPASS_ENDPOINTS", "https://op.internal/api/interpreter");
    providerFetch.mockResolvedValue(resp([el]));
    await raceOverpass("q", { treatEmptyAsFailure: false });
    expect(providerFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = providerFetch.mock.calls[0] as [string, { rateHost: string }];
    expect(url).toBe("https://op.internal/api/interpreter");
    expect(opts.rateHost).toBe("op.internal");
  });
});
