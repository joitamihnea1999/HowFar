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

import { buildRoutePathQuery, routePath } from "./route-path";

/** A minimal valid transit relation under `out geom`: one track way + one stop. */
function tramRelation(id: number) {
  return {
    type: "relation",
    id,
    tags: { type: "route", route: "tram", ref: "41" },
    members: [
      {
        type: "way",
        ref: 1,
        role: "",
        geometry: [
          { lat: 44.41, lon: 26.03 },
          { lat: 44.42, lon: 26.04 },
        ],
      },
      { type: "node", ref: 10, role: "stop", lat: 44.41, lon: 26.03 },
    ],
  };
}
const stopNode = { type: "node", id: 10, lat: 44.41, lon: 26.03, tags: { name: "Brașov" } };

beforeEach(() => {
  store.clear();
  raceOverpass.mockReset();
});

describe("buildRoutePathQuery", () => {
  it("is SET-SAFE: pins the relation to .r so the node statements can't clobber the seed", () => {
    expect(buildRoutePathQuery(412304)).toBe(
      `[out:json][timeout:25];rel(412304)->.r;.r out geom;` +
        `(node(r.r:"stop");node(r.r:"stop_entry_only");node(r.r:"stop_exit_only");` +
        `node(r.r:"platform");node(r.r:"platform_entry_only");node(r.r:"platform_exit_only"););out body;`,
    );
  });
});

describe("routePath", () => {
  it("fetches, parses, and caches a transit route's path (default empty-is-failure race)", async () => {
    raceOverpass.mockResolvedValueOnce([tramRelation(412304), stopNode]);
    const path = await routePath(412304);
    expect(path).toEqual({
      segments: [
        [
          [26.03, 44.41],
          [26.04, 44.42],
        ],
      ],
      stops: [{ lat: 44.41, lng: 26.03, name: "Brașov" }],
    });
    // Empties tolerated: a nonexistent id must cache a negative, not 502.
    expect(raceOverpass).toHaveBeenCalledWith(expect.stringContaining("rel(412304)->.r"), {
      treatEmptyAsFailure: false,
    });
    const expiry = store.get("route-path:v1:412304::expires") as Date;
    expect(expiry.getTime() - Date.now()).toBeGreaterThan(2 * 24 * 60 * 60 * 1000);
  });

  it("a NONEXISTENT relation (empty envelope from all hosts) → cached negative, not a 502 re-race", async () => {
    raceOverpass.mockResolvedValueOnce([]);
    await expect(routePath(123456789)).resolves.toBeNull();
    // The negative is cached: a second click never re-races the host pool.
    await expect(routePath(123456789)).resolves.toBeNull();
    expect(raceOverpass).toHaveBeenCalledTimes(1);
    const expiry = store.get("route-path:v1:123456789::expires") as Date;
    expect(expiry.getTime() - Date.now()).toBeLessThan(2 * 24 * 60 * 60 * 1000);
  });

  it("returns null for a relation that is NOT a transit route (client-supplied id hygiene)", async () => {
    raceOverpass.mockResolvedValueOnce([
      { type: "relation", id: 99, tags: { type: "multipolygon" }, members: [] },
    ]);
    await expect(routePath(99)).resolves.toBeNull();
  });

  it("returns null when the response's relation is a DIFFERENT id than requested", async () => {
    raceOverpass.mockResolvedValueOnce([tramRelation(555)]);
    await expect(routePath(412304)).resolves.toBeNull();
  });

  it("returns null for a transit route with no drawable track, cached SHORT (self-heals)", async () => {
    raceOverpass.mockResolvedValueOnce([
      { type: "relation", id: 7, tags: { type: "route", route: "bus", ref: "1" }, members: [] },
    ]);
    await expect(routePath(7)).resolves.toBeNull();
    const expiry = store.get("route-path:v1:7::expires") as Date;
    expect(expiry.getTime() - Date.now()).toBeLessThan(2 * 24 * 60 * 60 * 1000);
  });

  it("a cached negative is served as null WITHOUT a new race (not mistaken for a miss)", async () => {
    raceOverpass.mockResolvedValueOnce([
      { type: "relation", id: 99, tags: { type: "multipolygon" }, members: [] },
    ]);
    await routePath(99);
    await expect(routePath(99)).resolves.toBeNull();
    expect(raceOverpass).toHaveBeenCalledTimes(1);
  });

  it("serves a cache hit without a second race", async () => {
    raceOverpass.mockResolvedValueOnce([tramRelation(412304), stopNode]);
    await routePath(412304);
    await routePath(412304);
    expect(raceOverpass).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent cold clicks on one line into a single race", async () => {
    raceOverpass.mockResolvedValueOnce([tramRelation(412304), stopNode]);
    const [a, b] = await Promise.all([routePath(412304), routePath(412304)]);
    expect(a).toEqual(b);
    expect(raceOverpass).toHaveBeenCalledTimes(1);
  });

  it("propagates a provider failure (all endpoints down) rather than swallowing it", async () => {
    raceOverpass.mockRejectedValue(new Error("overpass unavailable"));
    await expect(routePath(1)).rejects.toThrow(/overpass unavailable/);
  });
});
