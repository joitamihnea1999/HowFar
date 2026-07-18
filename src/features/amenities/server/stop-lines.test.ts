import { beforeEach, describe, expect, it, vi } from "vitest";

const { store, raceOverpass } = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  raceOverpass: vi.fn(),
}));

vi.mock("@/lib/api-cache", () => ({
  getCachedSafe: (key: string) => Promise.resolve(store.has(key) ? store.get(key) : null),
  setCachedSafe: (key: string, value: unknown, expires: Date) => {
    store.set(key, value);
    store.set(`${key}::expires`, expires);
    return Promise.resolve();
  },
}));

vi.mock("@/features/amenities/server/overpass-client", () => ({ raceOverpass }));

import { buildAreaQuery, buildDirectQuery, stopLines } from "./stop-lines";

const routeRel = (tags: Record<string, string>) => ({ type: "relation", tags: { type: "route", ...tags } });

beforeEach(() => {
  store.clear();
  raceOverpass.mockReset();
});

describe("buildDirectQuery", () => {
  it("queries the stop's OWN route memberships — NO stop_area expansion (per-platform accurate)", () => {
    expect(buildDirectQuery("node", 444384784)).toBe(
      "[out:json][timeout:25];node(444384784);(rel(bn)[type=route];);out tags;",
    );
    expect(buildDirectQuery("node", 1)).not.toContain("stop_area");
  });

  it("uses the right seed + backward-recursion filter per OSM type", () => {
    expect(buildDirectQuery("way", 12)).toContain("way(12);(rel(bw)[type=route];)");
    expect(buildDirectQuery("relation", 12)).toContain("rel(12);(rel(br)[type=route];)");
  });
});

describe("buildAreaQuery (station fallback)", () => {
  it("expands via stop_area to member nodes/ways then their routes", () => {
    expect(buildAreaQuery("node", 582555685)).toBe(
      "[out:json][timeout:25];" +
        "node(582555685);" +
        "rel(bn)[public_transport=stop_area]->.sa;" +
        "(node(r.sa);way(r.sa););" +
        "(rel(bn)[type=route];rel(bw)[type=route];);" +
        "out tags;",
    );
  });
});

describe("stopLines — direct-first, stop_area fallback", () => {
  it("a surface stop with direct routes returns them in ONE race — never touches stop_area (no over-reach)", async () => {
    raceOverpass.mockResolvedValueOnce([
      routeRel({ route: "bus", ref: "331", to: "Cartier Dămăroaia" }),
      routeRel({ route: "bus", ref: "331", to: "Piața Romană" }),
    ]);
    const lines = await stopLines("node", 2518791544);
    expect(lines).toEqual([
      { mode: "bus", ref: "331", direction: "Cartier Dămăroaia" },
      { mode: "bus", ref: "331", direction: "Piața Romană" },
    ]);
    expect(raceOverpass).toHaveBeenCalledTimes(1); // direct only — the sibling-line over-reach is impossible
    expect(raceOverpass).toHaveBeenCalledWith(expect.stringContaining("(rel(bn)[type=route];)"), {
      treatEmptyAsFailure: false,
    });
  });

  it("a metro station (0 direct routes) falls back to the stop_area query (M2 both ways)", async () => {
    raceOverpass
      .mockResolvedValueOnce([]) // stage 1 direct: station node is a member of no route
      .mockResolvedValueOnce([
        routeRel({ route: "subway", ref: "M2", to: "Pipera" }),
        routeRel({ route: "subway", ref: "M2", to: "Tudor Arghezi" }),
      ]);
    const lines = await stopLines("node", 582555685);
    expect(lines).toEqual([
      { mode: "subway", ref: "M2", direction: "Pipera" },
      { mode: "subway", ref: "M2", direction: "Tudor Arghezi" },
    ]);
    expect(raceOverpass).toHaveBeenCalledTimes(2); // direct empty → area fallback
    expect(raceOverpass).toHaveBeenNthCalledWith(2, expect.stringContaining("stop_area"), {
      treatEmptyAsFailure: false,
    });
  });

  it("a genuinely lineless stop (direct + area both empty) resolves to [], short TTL", async () => {
    raceOverpass.mockResolvedValue([]);
    await expect(stopLines("node", 999)).resolves.toEqual([]);
    expect(raceOverpass).toHaveBeenCalledTimes(2);
    const emptyExpiry = store.get("stop-lines:v1:node/999::expires") as Date;
    expect(emptyExpiry.getTime() - Date.now()).toBeLessThan(2 * 24 * 60 * 60 * 1000);
  });

  it("passes treatEmptyAsFailure:false so a lineless stop is [] not a throw", async () => {
    raceOverpass.mockResolvedValue([]);
    await expect(stopLines("node", 998)).resolves.toEqual([]);
    expect(raceOverpass).toHaveBeenCalledWith(expect.any(String), { treatEmptyAsFailure: false });
  });

  it("propagates a provider failure (all endpoints down) rather than swallowing it", async () => {
    raceOverpass.mockRejectedValue(new Error("overpass unavailable"));
    await expect(stopLines("node", 1)).rejects.toThrow(/overpass unavailable/);
  });

  it("serves a cache hit without a second race", async () => {
    raceOverpass.mockResolvedValueOnce([routeRel({ route: "tram", ref: "1", to: "Romprim" })]);
    await stopLines("node", 419268473);
    await stopLines("node", 419268473);
    expect(raceOverpass).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent cold clicks on one stop into a single race", async () => {
    raceOverpass.mockResolvedValueOnce([routeRel({ route: "tram", ref: "1", to: "Romprim" })]);
    const [a, b] = await Promise.all([stopLines("node", 42), stopLines("node", 42)]);
    expect(a).toEqual(b);
    expect(raceOverpass).toHaveBeenCalledTimes(1);
  });

  it("caches a full result for LONGER than an empty one", async () => {
    raceOverpass.mockResolvedValueOnce([routeRel({ route: "bus", ref: "1", to: "X" })]);
    await stopLines("node", 8);
    const fullExpiry = store.get("stop-lines:v1:node/8::expires") as Date;
    expect(fullExpiry.getTime() - Date.now()).toBeGreaterThan(2 * 24 * 60 * 60 * 1000);
  });
});
