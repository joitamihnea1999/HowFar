import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  buildRoutePathFeatures,
  MAX_ROUTE_POINTS,
  MAX_ROUTE_SEGMENTS,
  MAX_ROUTE_STOPS,
  parseRoutePath,
  routePathBounds,
} from "./route-path";

// Trimmed REAL Overpass compound response for tram 41 (rel 412304, probed live
// 2026-07-18): a stop whose name-node rides along, a platform WAY with
// geometry (must NOT become track), stop/platform/stop_exit_only node roles,
// and two empty-role track ways.
const TRAM41_RELATION = {
  type: "relation",
  id: 412304,
  tags: { type: "route", route: "tram", ref: "41" },
  members: [
    { type: "node", ref: 8291116460, role: "stop", lat: 44.4148263, lon: 26.0349932 },
    {
      type: "way",
      ref: 1132031534,
      role: "platform",
      geometry: [
        { lat: 44.4148789, lon: 26.0350187 },
        { lat: 44.4145202, lon: 26.0351091 },
      ],
    },
    { type: "node", ref: 419547560, role: "stop", lat: 44.4184203, lon: 26.0344541 },
    { type: "node", ref: 8291116436, role: "stop", lat: 44.4226856, lon: 26.0344796 },
    { type: "node", ref: 5235498301, role: "platform", lat: 44.4226576, lon: 26.0345077 },
    { type: "node", ref: 2521620174, role: "stop_exit_only", lat: 44.4753545, lon: 26.0722182 },
    {
      type: "way",
      ref: 1409729773,
      role: "",
      geometry: [
        { lat: 44.4151983, lon: 26.047035 },
        { lat: 44.4152042, lon: 26.0469591 },
        { lat: 44.4151992, lon: 26.0468577 },
      ],
    },
    {
      type: "way",
      ref: 550861987,
      role: "",
      geometry: [
        { lat: 44.415114, lon: 26.045899 },
        { lat: 44.4150924, lon: 26.0456562 },
      ],
    },
  ],
};
const TRAM41_NODES = [
  { type: "node", id: 419547560, lat: 44.4184203, lon: 26.0344541, tags: { name: "Parcul Drumul Taberei" } },
  { type: "node", id: 2521620174, lat: 44.4753545, lon: 26.0722182, tags: { name: "Piața Presei" } },
  { type: "node", id: 8291116436, lat: 44.4226856, lon: 26.0344796, tags: { name: "Drumul Taberei" } },
  { type: "node", id: 8291116460, lat: 44.4148263, lon: 26.0349932, tags: { name: "Brașov" } },
];
const TRAM41 = [TRAM41_RELATION, ...TRAM41_NODES];

describe("parseRoutePath", () => {
  it("parses the real tram-41 shape: track = EMPTY-role ways only, stops named via the node join", () => {
    const path = parseRoutePath(TRAM41);

    // 2 empty-role ways; the platform WAY's geometry must NOT appear as track.
    expect(path.segments).toEqual([
      [
        [26.047035, 44.4151983],
        [26.0469591, 44.4152042],
        [26.0468577, 44.4151992],
      ],
      [
        [26.045899, 44.415114],
        [26.0456562, 44.4150924],
      ],
    ]);

    // stop* roles in member order (incl. stop_exit_only), platform NODE ignored
    // (stop-role positions exist), names joined by node id.
    expect(path.stops).toEqual([
      { lat: 44.4148263, lng: 26.0349932, name: "Brașov" },
      { lat: 44.4184203, lng: 26.0344541, name: "Parcul Drumul Taberei" },
      { lat: 44.4226856, lng: 26.0344796, name: "Drumul Taberei" },
      { lat: 44.4753545, lng: 26.0722182, name: "Piața Presei" },
    ]);
  });

  it("falls back to platform-role NODES when a relation has no stop-role nodes", () => {
    const path = parseRoutePath([
      {
        type: "relation",
        id: 1,
        members: [
          { type: "node", ref: 10, role: "platform", lat: 44.4, lon: 26.1 },
          { type: "node", ref: 11, role: "platform_entry_only", lat: 44.5, lon: 26.2 },
        ],
      },
      { type: "node", id: 10, lat: 44.4, lon: 26.1, tags: { name: "Peron" } },
    ]);
    expect(path.stops).toEqual([
      { lat: 44.4, lng: 26.1, name: "Peron" },
      { lat: 44.5, lng: 26.2 },
    ]);
  });

  it("keeps a stop without a name as an unnamed dot (never invents)", () => {
    const path = parseRoutePath([
      { type: "relation", id: 1, members: [{ type: "node", ref: 99, role: "stop", lat: 44.4, lon: 26.1 }] },
    ]);
    expect(path.stops).toEqual([{ lat: 44.4, lng: 26.1 }]);
    expect(path.stops[0]).not.toHaveProperty("name");
  });

  it("dedups a revisited terminus (circular route) by node identity", () => {
    const stop = { type: "node", ref: 7, role: "stop", lat: 44.4, lon: 26.1 };
    const path = parseRoutePath([
      { type: "relation", id: 1, members: [stop, { type: "node", ref: 8, role: "stop", lat: 44.5, lon: 26.2 }, stop] },
    ]);
    expect(path.stops).toHaveLength(2);
  });

  it("skips malformed members: non-finite coords, <2-point ways, junk entries", () => {
    const path = parseRoutePath([
      {
        type: "relation",
        id: 1,
        members: [
          { type: "node", ref: 1, role: "stop", lat: Number.NaN, lon: 26.1 },
          { type: "node", ref: 2, role: "stop" }, // no coords
          { type: "way", ref: 3, role: "", geometry: [{ lat: 44.4, lon: 26.1 }] }, // 1 point
          { type: "way", ref: 4, role: "" }, // no geometry
          null,
          "junk",
          { type: "node", ref: 5, role: "stop", lat: 44.4, lon: 26.1 }, // the one survivor
        ],
      },
    ]);
    expect(path.segments).toEqual([]);
    expect(path.stops).toEqual([{ lat: 44.4, lng: 26.1 }]);
  });

  it("bounds the output (client-named id ⇒ the response must stay bounded)", () => {
    const members = [
      ...Array.from({ length: MAX_ROUTE_STOPS + 50 }, (_, i) => ({
        type: "node",
        ref: i + 1,
        role: "stop",
        lat: 44 + i * 1e-6,
        lon: 26,
      })),
      ...Array.from({ length: MAX_ROUTE_SEGMENTS + 50 }, (_, i) => ({
        type: "way",
        ref: 100_000 + i,
        role: "",
        geometry: [
          { lat: 44, lon: 26 },
          { lat: 44.1, lon: 26.1 },
        ],
      })),
    ];
    const path = parseRoutePath([{ type: "relation", id: 1, members }]);
    expect(path.stops).toHaveLength(MAX_ROUTE_STOPS);
    expect(path.segments).toHaveLength(MAX_ROUTE_SEGMENTS);
  });

  it("keeps forward/backward-role ways as track (valid pre-PTv2 mapping) but never platform ways", () => {
    const geometry = [
      { lat: 44.4, lon: 26.1 },
      { lat: 44.5, lon: 26.2 },
    ];
    const path = parseRoutePath([
      {
        type: "relation",
        id: 1,
        members: [
          { type: "way", ref: 1, role: "forward", geometry },
          { type: "way", ref: 2, role: "backward", geometry },
          { type: "way", ref: 3, role: "platform", geometry },
        ],
      },
    ]);
    expect(path.segments).toHaveLength(2);
  });

  it("bounds the TOTAL track points, not just the segment count (dense-way payload guard)", () => {
    const densePoints = Array.from({ length: 15_000 }, (_, i) => ({ lat: 44 + i * 1e-7, lon: 26 }));
    const path = parseRoutePath([
      {
        type: "relation",
        id: 1,
        members: [
          { type: "way", ref: 1, role: "", geometry: densePoints },
          { type: "way", ref: 2, role: "", geometry: densePoints }, // would exceed the budget
          {
            type: "way",
            ref: 3,
            role: "",
            geometry: [
              { lat: 44, lon: 26 },
              { lat: 44.1, lon: 26.1 },
            ],
          }, // small: still fits the remaining budget
        ],
      },
    ]);
    expect(path.segments).toHaveLength(2);
    const total = path.segments.reduce((n, s) => n + s.length, 0);
    expect(total).toBeLessThanOrEqual(MAX_ROUTE_POINTS);
  });

  it("returns the empty shape for junk input (no relation, wrong types, null)", () => {
    for (const junk of [null, undefined, 42, "x", {}, [], [{ type: "node" }]]) {
      expect(parseRoutePath(junk)).toEqual({ segments: [], stops: [] });
    }
  });

  it("buildRoutePathFeatures splits track (LineString) from stops (Point, named when known)", () => {
    const features = buildRoutePathFeatures({
      segments: [
        [
          [26.03, 44.41],
          [26.04, 44.42],
        ],
      ],
      stops: [
        { lat: 44.41, lng: 26.03, name: "Brașov" },
        { lat: 44.42, lng: 26.04 },
      ],
    });
    expect(features).toEqual([
      {
        type: "Feature",
        properties: {},
        geometry: {
          type: "LineString",
          coordinates: [
            [26.03, 44.41],
            [26.04, 44.42],
          ],
        },
      },
      { type: "Feature", properties: { name: "Brașov" }, geometry: { type: "Point", coordinates: [26.03, 44.41] } },
      { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [26.04, 44.42] } },
    ]);
  });

  it("routePathBounds spans segments AND stops; null for a degenerate path", () => {
    expect(
      routePathBounds({
        segments: [
          [
            [26.03, 44.41],
            [26.05, 44.4],
          ],
        ],
        stops: [{ lat: 44.47, lng: 26.07 }],
      }),
    ).toEqual([
      [26.03, 44.4],
      [26.07, 44.47],
    ]);
    expect(routePathBounds({ segments: [], stops: [] })).toBeNull();
  });

  it("property: total on arbitrary junk, and every stop comes from a stop*/platform*-role node member", () => {
    const memberArb = fc.oneof(
      fc.record({
        type: fc.constantFrom("node", "way", "relation", "nope"),
        ref: fc.option(fc.integer(), { nil: undefined }),
        role: fc.option(fc.constantFrom("stop", "stop_exit_only", "platform", "", "backward"), {
          nil: undefined,
        }),
        lat: fc.option(fc.double({ noNaN: false }), { nil: undefined }),
        lon: fc.option(fc.double({ noNaN: false }), { nil: undefined }),
      }),
      fc.constant(null),
      fc.string(),
    );
    const elementsArb = fc.array(
      fc.oneof(
        fc.record({ type: fc.constant("relation"), id: fc.integer(), members: fc.array(memberArb) }),
        fc.record({ type: fc.constant("node"), id: fc.integer() }),
        fc.constant(null),
        fc.string(),
      ),
    );
    fc.assert(
      fc.property(elementsArb, (elements) => {
        const path = parseRoutePath(elements); // must not throw
        const list: unknown[] = Array.isArray(elements) ? elements : [];
        const relation = list.find(
          (e): e is { type: string; members: unknown[] } =>
            !!e &&
            typeof e === "object" &&
            (e as { type?: string }).type === "relation" &&
            Array.isArray((e as { members?: unknown[] }).members),
        );
        const passengerCoords = new Set(
          (relation?.members ?? [])
            .filter(
              (m): m is { role: string; lat: number; lon: number; type: string } =>
                !!m &&
                typeof m === "object" &&
                (m as { type?: string }).type === "node" &&
                typeof (m as { role?: string }).role === "string" &&
                ((m as { role: string }).role.startsWith("stop") ||
                  (m as { role: string }).role.startsWith("platform")),
            )
            .map((m) => `${m.lat},${m.lon}`),
        );
        for (const s of path.stops) {
          expect(passengerCoords.has(`${s.lat},${s.lng}`)).toBe(true);
        }
      }),
    );
  });
});
