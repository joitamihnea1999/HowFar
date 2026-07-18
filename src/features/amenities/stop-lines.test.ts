import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { modeLabel, parseRouteRelations, TRANSIT_ROUTE_VALUES } from "./stop-lines";

/** Build an Overpass route-relation element (defaults to a valid bus route). */
const rel = (tags: Record<string, string>, type = "relation") => ({ type, tags });
const route = (over: Record<string, string> = {}) =>
  rel({ type: "route", route: "bus", ref: "1", ...over });

describe("parseRouteRelations", () => {
  it("extracts mode + ref + direction from `to` (the real Bucharest shape)", () => {
    const { lines } = parseRouteRelations(
      [route({ route: "bus", ref: "368", to: "Valea Oltului", from: "Piața Romană" })],
      "Nicolae Golescu",
    );
    expect(lines).toEqual([{ mode: "bus", ref: "368", direction: "Valea Oltului" }]);
  });

  it("keeps BOTH direction variants of one ref as two rows", () => {
    const { lines } = parseRouteRelations(
      [
        route({ ref: "331", to: "Cartier Dămăroaia", from: "Piața Romană" }),
        route({ ref: "331", to: "Piața Romană", from: "Cartier Dămăroaia" }),
      ],
      "Piața Romană",
    );
    expect(lines).toEqual([
      { mode: "bus", ref: "331", direction: "Cartier Dămăroaia" },
      { mode: "bus", ref: "331", direction: "Piața Romană" },
    ]);
  });

  it("NEVER uses `from` as the direction — only `from`, no `to`/parseable name → no direction", () => {
    const { lines } = parseRouteRelations(
      [route({ ref: "5", from: "Depou Militari" })], // no `to`, no separator name
      "stop",
    );
    expect(lines).toEqual([{ mode: "bus", ref: "5" }]);
    expect(lines[0]).not.toHaveProperty("direction");
  });

  it("parses the destination terminus from `name` when `to` is absent (mixed separators)", () => {
    const { lines } = parseRouteRelations(
      [
        route({ route: "bus", ref: "368", name: "Bus 368: Piața Romană => Valea Oltului" }),
        route({ route: "bus", ref: "301", name: "Bus 301: Pasaj CFR Tunari → Piața Romană" }),
        route({ route: "tram", ref: "1", name: "Tram 1: Romprim => Mihai Bravu => Banu Manta => Romprim" }),
        route({ route: "subway", ref: "M2", name: "Magistrala 2 (Tudor Arghezi → Pipera)" }),
      ],
      "stop",
    );
    const byRef = Object.fromEntries(lines.map((l) => [l.ref, l.direction]));
    expect(byRef["368"]).toBe("Valea Oltului");
    expect(byRef["301"]).toBe("Piața Romană");
    expect(byRef["1"]).toBe("Romprim"); // last segment of a multi-hop name
    expect(byRef["M2"]).toBe("Pipera"); // parens stripped
  });

  it("prefers `to` over the name-parsed terminus when both exist", () => {
    const { lines } = parseRouteRelations(
      [route({ ref: "7", to: "Actual Dest", name: "Bus 7: X => Wrong Dest" })],
      "stop",
    );
    expect(lines[0].direction).toBe("Actual Dest");
  });

  it("shows a circular/single-direction route (no `to`, no separator) as ref alone", () => {
    const { lines } = parseRouteRelations([route({ ref: "104", name: "Bus 104 circular" })], "stop");
    expect(lines).toEqual([{ mode: "bus", ref: "104" }]);
  });

  it("drops refless relations", () => {
    const { lines } = parseRouteRelations(
      [
        route({ ref: "", to: "Somewhere" }),
        rel({ type: "route", route: "bus", to: "Nowhere" }), // no `ref` tag at all
        route({ ref: "  " }),
      ],
      "stop",
    );
    expect(lines).toEqual([]);
  });

  it("filters non-route relations and non-transit route modes", () => {
    const { lines } = parseRouteRelations(
      [
        rel({ type: "route", route: "hiking", ref: "EV6" }), // not transit
        rel({ type: "multipolygon", ref: "99" }), // not a route
        rel({ type: "route", route: "road", ref: "A1" }), // not transit
        route({ route: "trolleybus", ref: "70", to: "Piața Sudului" }), // kept
      ],
      "stop",
    );
    expect(lines).toEqual([{ mode: "trolleybus", ref: "70", direction: "Piața Sudului" }]);
  });

  it("filters relation elements whose element type is not `relation` (e.g. a node)", () => {
    const { lines } = parseRouteRelations(
      [rel({ type: "route", route: "bus", ref: "1", to: "X" }, "node")],
      "stop",
    );
    expect(lines).toEqual([]);
  });

  it("dedups true duplicates but keeps distinct (mode, ref, direction)", () => {
    const { lines } = parseRouteRelations(
      [
        route({ ref: "5", to: "A" }),
        route({ ref: "5", to: "A" }), // exact dup → collapsed
        rel({ type: "route", route: "tram", ref: "5", to: "A" }), // same ref, different mode → kept
      ],
      "stop",
    );
    expect(lines).toEqual([
      { mode: "bus", ref: "5", direction: "A" },
      { mode: "tram", ref: "5", direction: "A" },
    ]);
  });

  it("sorts by mode order, then numeric-aware ref, then direction", () => {
    const { lines } = parseRouteRelations(
      [
        rel({ type: "route", route: "subway", ref: "M2", to: "Pipera" }),
        route({ ref: "331B", to: "Z" }),
        route({ ref: "46", to: "Y" }),
        rel({ type: "route", route: "tram", ref: "1", to: "B" }),
        route({ ref: "46", to: "A" }),
      ],
      "stop",
    );
    expect(lines).toEqual([
      { mode: "bus", ref: "46", direction: "A" }, // bus first, ref 46 numeric, dir A < Y
      { mode: "bus", ref: "46", direction: "Y" },
      { mode: "bus", ref: "331B", direction: "Z" }, // 331B after 46 numerically
      { mode: "tram", ref: "1", direction: "B" }, // tram after bus
      { mode: "subway", ref: "M2", direction: "Pipera" }, // subway last; M2 non-numeric
    ]);
  });

  it("carries the OSM relation id so the client can draw the route's path (task 024)", () => {
    const { lines } = parseRouteRelations(
      [{ type: "relation", id: 1766705, tags: { type: "route", route: "bus", ref: "301", to: "Piața Romană" } }],
      "stop",
    );
    expect(lines).toEqual([
      { mode: "bus", ref: "301", direction: "Piața Romană", relationId: 1766705 },
    ]);
  });

  it("omits relationId for a malformed id (row still informs, just can't draw)", () => {
    for (const id of [0, -3, 1.5, "12" as unknown as number, undefined]) {
      const { lines } = parseRouteRelations(
        [{ type: "relation", id, tags: { type: "route", route: "bus", ref: "9", to: "X" } }],
        "stop",
      );
      expect(lines).toHaveLength(1);
      expect(lines[0]).not.toHaveProperty("relationId");
    }
  });

  it("dedup keeps the FIRST relation's id per (mode,ref,direction) — variants collapse deterministically", () => {
    const tags = { type: "route", route: "bus", ref: "5", to: "A" };
    const { lines } = parseRouteRelations(
      [
        { type: "relation", id: 100, tags },
        { type: "relation", id: 200, tags }, // short-turn variant, same key → dropped
      ],
      "stop",
    );
    expect(lines).toEqual([{ mode: "bus", ref: "5", direction: "A", relationId: 100 }]);
  });

  it("returns an empty list (with the fallback name) for a non-array or empty input", () => {
    expect(parseRouteRelations(null, "Gara de Nord")).toEqual({ name: "Gara de Nord", lines: [] });
    expect(parseRouteRelations([], "Gara de Nord")).toEqual({ name: "Gara de Nord", lines: [] });
    expect(parseRouteRelations([null, "nope", { tags: null }], "x").lines).toEqual([]);
  });

  it("property: dedup is idempotent — parsing a doubled list equals parsing once", () => {
    const elArb = fc
      .record({
        route: fc.constantFrom(...TRANSIT_ROUTE_VALUES, "hiking"),
        ref: fc.string({ maxLength: 4 }),
        to: fc.option(fc.string({ maxLength: 8 }), { nil: undefined }),
      })
      .map(({ route, ref, to }) => {
        const tags: Record<string, string> = { type: "route", route, ref };
        if (to !== undefined) tags.to = to;
        return { type: "relation", tags };
      });
    fc.assert(
      fc.property(fc.array(elArb), (els) => {
        const once = parseRouteRelations(els, "s");
        const twice = parseRouteRelations([...els, ...els], "s");
        expect(twice).toEqual(once);
      }),
    );
  });
});

describe("modeLabel", () => {
  it("maps OSM route values to human labels", () => {
    expect(modeLabel("subway")).toBe("Metro");
    expect(modeLabel("bus")).toBe("Bus");
    expect(modeLabel("tram")).toBe("Tram");
    expect(modeLabel("trolleybus")).toBe("Trolleybus");
  });

  it("echoes an unknown mode unchanged", () => {
    expect(modeLabel("funicular")).toBe("funicular");
  });
});
