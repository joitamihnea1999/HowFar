import { describe, expect, it } from "vitest";

import type { Amenity } from "@/features/amenities/amenities";
import {
  haversineMeters,
  mergeCoincidentTransitStops,
  normalizeStopName,
} from "@/features/amenities/server/merge-transit-stops";

// Real Bucharest OSM nodes (catalogued modes only: bus_stop/tram_stop/station),
// measured live for task 047 (see .agent/tasks/047/calibration-stops.json). These
// are the ground truth the merge is calibrated against.
type Stop = { name: string; lat: number; lng: number; modes: string[]; osmId: number };

function amenity(s: Stop): Amenity {
  return {
    name: s.name,
    lat: s.lat,
    lng: s.lng,
    category: "transit",
    osmType: "node",
    osmId: s.osmId,
    modes: s.modes,
  };
}

/** Sort by distance from an origin, mirroring the catalogue query's ORDER BY so
 * the representative is the nearest member. */
function byDistanceFrom(origin: { lat: number; lng: number }, stops: Amenity[]): Amenity[] {
  return [...stops].sort(
    (a, b) =>
      haversineMeters(origin.lat, origin.lng, a.lat, a.lng) -
      haversineMeters(origin.lat, origin.lng, b.lat, b.lng),
  );
}

const SAVINESTI_STADION: Stop[] = [
  { name: "Savinesti", lat: 44.38899, lng: 26.132535, modes: ["tram"], osmId: 1317254648 },
  { name: "Savinesti", lat: 44.389021, lng: 26.132357, modes: ["tram"], osmId: 6247768552 },
  { name: "Savinesti", lat: 44.389012, lng: 26.13253, modes: ["bus", "tram"], osmId: 10106002817 },
  { name: "Stadion", lat: 44.38901, lng: 26.132326, modes: ["bus"], osmId: 10105969616 },
];

// Two "Stadionul Dinamo" bus stops 26m apart — same name, same mode, opposite
// kerbs: the canonical "keep separate" case (≥ the 26m separate floor).
const DINAMO_BUS_PAIR: Stop[] = [
  { name: "Stadionul Dinamo", lat: 44.452861, lng: 26.103993, modes: ["bus"], osmId: 3583477525 },
  { name: "Stadionul Dinamo", lat: 44.453095, lng: 26.104003, modes: ["bus"], osmId: 4191634967 },
];

// The near Vitan-Bârzești sub-cluster: a tram spelled "Sos. Vitan Barzesti" and a
// bus spelled "Șoseaua Vitan-Bârzești", ~3m apart (cross-mode).
const VITAN_NEAR: Stop[] = [
  { name: "Sos. Vitan Barzesti", lat: 44.386204, lng: 26.138983, modes: ["tram"], osmId: 1317254643 },
  { name: "Șoseaua Vitan-Bârzești", lat: 44.386178, lng: 26.138969, modes: ["bus"], osmId: 3017663404 },
];

describe("normalizeStopName", () => {
  it("folds diacritics/case and strips a leading street generic so spelling variants match", () => {
    expect(normalizeStopName("Șoseaua Vitan-Bârzești")).toBe("vitanbarzesti");
    expect(normalizeStopName("Sos. Vitan Barzesti")).toBe("vitanbarzesti");
    expect(normalizeStopName("Șos. Vitan Bârzești")).toBe("vitanbarzesti");
  });

  it("never strips a DISTINGUISHING head word (Pod/Cartier/Complex)", () => {
    expect(normalizeStopName("Pod Vitan-Bârzești")).toBe("podvitanbarzesti");
    expect(normalizeStopName("Cartier Vitan-Bârzești")).toBe("cartiervitanbarzesti");
    expect(normalizeStopName("Complex Comercial Vitan-Bârzești")).toBe("complexcomercialvitanbarzesti");
    // and these are all DIFFERENT from the bare street name → never fused
    expect(normalizeStopName("Pod Vitan-Bârzești")).not.toBe(normalizeStopName("Șoseaua Vitan-Bârzești"));
  });

  it("returns '' for a nameless stop (never merges two unnamed same-mode stops on name)", () => {
    expect(normalizeStopName(null)).toBe("");
    expect(normalizeStopName("")).toBe("");
    expect(normalizeStopName("   ")).toBe("");
  });

  it("keeps the generic itself when stripping would empty the name (a stop literally named 'Șoseaua')", () => {
    expect(normalizeStopName("Șoseaua")).toBe("soseaua");
  });
});

describe("mergeCoincidentTransitStops — real calibration clusters", () => {
  it("fuses the Savinesti/Stadion interchange (2 tram + 1 bus+tram + 1 bus) into ONE marker", () => {
    const origin = { lat: 44.3892, lng: 26.1325 };
    const items = byDistanceFrom(origin, SAVINESTI_STADION.map(amenity));
    const { amenities, absorbedTransit } = mergeCoincidentTransitStops(items);

    const transit = amenities.filter((a) => a.category === "transit");
    expect(transit).toHaveLength(1);
    expect(transit[0].members).toHaveLength(4);
    expect(transit[0].mergedCount).toBe(4);
    expect(absorbedTransit).toBe(3);
    // representative is the nearest member
    expect(transit[0].osmId).toBe(items[0].osmId);
    // every input identity is preserved among the members (partition)
    expect(new Set(transit[0].members!.map((m) => m.osmId))).toEqual(
      new Set(SAVINESTI_STADION.map((s) => s.osmId)),
    );
  });

  it("merges Vitan-Bârzești spelling variants that sit ~3m apart (cross-mode, no name check needed)", () => {
    const { amenities, absorbedTransit } = mergeCoincidentTransitStops(VITAN_NEAR.map(amenity));
    expect(amenities).toHaveLength(1);
    expect(amenities[0].mergedCount).toBe(2);
    expect(absorbedTransit).toBe(1);
  });

  it("keeps the two 'Stadionul Dinamo' bus stops (26m, same name/mode, opposite kerbs) SEPARATE", () => {
    const { amenities, absorbedTransit } = mergeCoincidentTransitStops(DINAMO_BUS_PAIR.map(amenity));
    expect(amenities).toHaveLength(2);
    expect(amenities.every((a) => a.members === undefined)).toBe(true);
    expect(absorbedTransit).toBe(0);
  });

  it("keeps 'Pod'/'Cartier'/'Complex Comercial'/'Șoseaua' Vitan-Bârzești as distinct markers", () => {
    // Deliberately place them CLOSE (10m spread) so ONLY the name rule protects
    // them — proves the generic-strip never fuses same-street-different-stop.
    const base = { lat: 44.4, lng: 26.14 };
    const stops: Stop[] = [
      { name: "Șoseaua Vitan-Bârzești", ...base, modes: ["bus"], osmId: 1 },
      { name: "Pod Vitan-Bârzești", lat: 44.40004, lng: 26.14, modes: ["bus"], osmId: 2 },
      { name: "Cartier Vitan-Bârzești", lat: 44.40008, lng: 26.14, modes: ["bus"], osmId: 3 },
      { name: "Complex Comercial Vitan-Bârzești", lat: 44.40004, lng: 26.14004, modes: ["bus"], osmId: 4 },
    ];
    const { amenities } = mergeCoincidentTransitStops(stops.map(amenity));
    expect(amenities).toHaveLength(4);
    expect(amenities.every((a) => a.members === undefined)).toBe(true);
  });
});

describe("mergeCoincidentTransitStops — conservative guardrails", () => {
  it("does NOT merge a same-mode same-name pair in the 16–25m grey zone (22m)", () => {
    // 22m north-south (Δlat 22/111320)
    const stops: Stop[] = [
      { name: "Piata Sudului", lat: 44.4, lng: 26.14, modes: ["bus"], osmId: 1 },
      { name: "Piata Sudului", lat: 44.4 + 22 / 111320, lng: 26.14, modes: ["bus"], osmId: 2 },
    ];
    const { amenities } = mergeCoincidentTransitStops(stops.map(amenity));
    expect(amenities).toHaveLength(2);
  });

  it("does NOT merge same-mode stops with DIFFERENT names even when very close (5m)", () => {
    const stops: Stop[] = [
      { name: "Alpha", lat: 44.4, lng: 26.14, modes: ["bus"], osmId: 1 },
      { name: "Beta", lat: 44.4 + 5 / 111320, lng: 26.14, modes: ["bus"], osmId: 2 },
    ];
    const { amenities } = mergeCoincidentTransitStops(stops.map(amenity));
    expect(amenities).toHaveLength(2);
  });

  it("MERGES a same-mode same-name pair when genuinely coincident (14.6m, the Savinesti tram case)", () => {
    const stops: Stop[] = [
      { name: "Savinesti", lat: 44.38899, lng: 26.132535, modes: ["tram"], osmId: 1 },
      { name: "Savinesti", lat: 44.389021, lng: 26.132357, modes: ["tram"], osmId: 2 },
    ];
    const { amenities } = mergeCoincidentTransitStops(stops.map(amenity));
    expect(amenities).toHaveLength(1);
    expect(amenities[0].mergedCount).toBe(2);
  });

  it("is inclusive at exactly 18m and excludes just over (locks the <= boundary)", () => {
    const pair = (meters: number): Stop[] => [
      { name: "X", lat: 44.4, lng: 26.14, modes: ["bus"], osmId: 1 },
      { name: "X", lat: 44.4 + meters / 111320, lng: 26.14, modes: ["bus"], osmId: 2 },
    ];
    expect(mergeCoincidentTransitStops(pair(18).map(amenity)).amenities).toHaveLength(1); // 18.0m merges
    expect(mergeCoincidentTransitStops(pair(19).map(amenity)).amenities).toHaveLength(2); // 19m separate
  });

  it("does NOT let a mid-road stop bridge two opposite-kerb stops 26m apart into one marker (F1)", () => {
    // A and B are the 26m opposite-kerb pair (like Stadionul Dinamo); M sits mid-
    // road ~13m from each. Every hop is a same-name same-mode edge (≤18m), but the
    // A–B span (26m) exceeds MAX_SPAN, so M merges with the nearer kerb only.
    const stops: Stop[] = [
      { name: "Kerb", lat: 44.4, lng: 26.14, modes: ["bus"], osmId: 1 },
      { name: "Kerb", lat: 44.4 + 13 / 111320, lng: 26.14, modes: ["bus"], osmId: 2 }, // mid
      { name: "Kerb", lat: 44.4 + 26 / 111320, lng: 26.14, modes: ["bus"], osmId: 3 },
    ];
    const { amenities } = mergeCoincidentTransitStops(stops.map(amenity));
    expect(amenities).toHaveLength(2); // one merged pair + one lone kerb, never a single 26m blob
    expect(amenities.filter((a) => a.mergedCount).map((a) => a.mergedCount)).toEqual([2]);
  });

  it("fails safe: an empty-mode stop is NOT cross-merged (name-free) with a moded stop", () => {
    const stops: Stop[] = [
      { name: "Alpha", lat: 44.4, lng: 26.14, modes: [], osmId: 1 },
      { name: "Beta", lat: 44.4 + 5 / 111320, lng: 26.14, modes: ["bus"], osmId: 2 },
    ];
    // Different names, 5m apart: empty modes falls back to same-mode → name check → separate.
    expect(mergeCoincidentTransitStops(stops.map(amenity)).amenities).toHaveLength(2);
  });

  it("treats a dual-tagged node (bus_stop + tram=yes) as cross-mode vs a pure tram stop", () => {
    // modes differ ({bus,tram} vs {tram}) → cross-mode → merges within 18m with
    // NO name check, even though names differ. (sonnet plan-review finding.)
    const stops: Stop[] = [
      { name: "Depou", lat: 44.4, lng: 26.14, modes: ["bus", "tram"], osmId: 10106002817 },
      { name: "Terminus", lat: 44.4 + 10 / 111320, lng: 26.14, modes: ["tram"], osmId: 2 },
    ];
    const { amenities } = mergeCoincidentTransitStops(stops.map(amenity));
    expect(amenities).toHaveLength(1);
  });
});

describe("mergeCoincidentTransitStops — clustering (Kruskal + diameter cap)", () => {
  it("does not let a bridge over-extend a component past MAX_SPAN, and a good tight pair survives", () => {
    // Colinear A(0m) — B(18m) — C(36m), all cross-mode so every hop is an edge.
    // A–C = 36m > MAX_SPAN(35): the far edge is DROPPED (not the whole component
    // dissolved), so exactly ONE tight pair merges and the third stays separate.
    const m = (i: number, modes: string[]) => ({
      name: `S${i}`,
      lat: 44.4 + (i * 18) / 111320,
      lng: 26.14,
      modes,
      osmId: i + 1,
    });
    const stops = [m(0, ["bus"]), m(1, ["tram"]), m(2, ["bus"])];
    const { amenities } = mergeCoincidentTransitStops(stops.map(amenity));
    const merged = amenities.filter((a) => a.mergedCount);
    const singles = amenities.filter((a) => !a.mergedCount);
    expect(amenities).toHaveLength(2);
    expect(merged).toHaveLength(1);
    expect(merged[0].mergedCount).toBe(2);
    expect(singles).toHaveLength(1);
  });

  it("passes non-transit items through untouched and preserves order", () => {
    const items: Amenity[] = [
      { name: "Mega", lat: 44.4, lng: 26.14, category: "groceries", osmType: "node", osmId: 9 },
      ...SAVINESTI_STADION.map(amenity),
      { name: "Park", lat: 44.41, lng: 26.15, category: "parks", osmType: "way", osmId: 8 },
    ];
    const { amenities } = mergeCoincidentTransitStops(items);
    expect(amenities[0].category).toBe("groceries");
    expect(amenities[amenities.length - 1].category).toBe("parks");
    expect(amenities.filter((a) => a.category === "transit")).toHaveLength(1);
  });

  it("is idempotent: merging an already-merged list changes nothing", () => {
    const once = mergeCoincidentTransitStops(SAVINESTI_STADION.map(amenity));
    const twice = mergeCoincidentTransitStops(once.amenities);
    expect(twice.absorbedTransit).toBe(0);
    expect(twice.amenities).toHaveLength(once.amenities.length);
    expect(twice.amenities[0].members).toHaveLength(4);
  });

  it("falls back to empty identity for a merged member that lacks osmType/osmId", () => {
    const items: Amenity[] = [
      { name: "A", lat: 44.4, lng: 26.14, category: "transit", osmType: "node", osmId: 1, modes: ["bus"] },
      // malformed stop with no OSM identity, 5m away, cross-mode → still merged
      { name: "B", lat: 44.4 + 5 / 111320, lng: 26.14, category: "transit", modes: ["tram"] },
    ];
    const { amenities } = mergeCoincidentTransitStops(items);
    expect(amenities).toHaveLength(1);
    const b = amenities[0].members!.find((m) => m.name === "B")!;
    expect(b.osmType).toBe("");
    expect(b.osmId).toBe(0);
  });

  it("leaves a single transit stop (or empty input) alone", () => {
    expect(mergeCoincidentTransitStops([]).amenities).toHaveLength(0);
    const one = mergeCoincidentTransitStops([amenity(SAVINESTI_STADION[0])]);
    expect(one.amenities).toHaveLength(1);
    expect(one.amenities[0].members).toBeUndefined();
    expect(one.absorbedTransit).toBe(0);
  });
});
