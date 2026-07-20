import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  cleanAmenityName,
  normalizeAmenityName,
  normalizeCatalogueElement,
} from "./catalogue-normalize";

describe("catalogue normalization and quality rules", () => {
  it("normalizes display/search names without losing the display accents", () => {
    expect(cleanAmenityName("  Parcul   Tineretului \n")).toBe("Parcul Tineretului");
    expect(normalizeAmenityName("Școala Țăndărică")).toBe("scoala tandarica");
  });

  it("excludes lifecycle objects, private parks, and unnamed gardens", () => {
    const base = { type: "node", id: 1, lat: 44.43, lon: 26.1 } as const;
    expect(
      normalizeCatalogueElement({ ...base, tags: { leisure: "park", disused: "yes" } }),
    ).toEqual({ dropReason: "lifecycle" });
    expect(
      normalizeCatalogueElement({
        ...base,
        tags: { leisure: "park", name: "Closed Park", access: "private" },
      }),
    ).toEqual({ dropReason: "private_park" });
    expect(normalizeCatalogueElement({ ...base, tags: { leisure: "garden" } })).toEqual({
      dropReason: "unnamed_garden",
    });
  });

  it("applies auditable source-ID suppression before geometry ingestion", () => {
    const result = normalizeCatalogueElement(
      {
        type: "node",
        id: 42,
        lat: 44.43,
        lon: 26.1,
        tags: { amenity: "pharmacy", name: "Incorrect POI" },
      },
      new Set(["node/42"]),
    );
    expect(result).toEqual({ dropReason: "manual_suppression" });
  });

  it("turns closed ways and relation member lines into database-ready geometry", () => {
    const polygon = normalizeCatalogueElement({
      type: "way",
      id: 10,
      tags: { amenity: "school", name: "School" },
      geometry: [
        { lat: 44.42, lon: 26.1 },
        { lat: 44.42, lon: 26.11 },
        { lat: 44.43, lon: 26.11 },
        { lat: 44.42, lon: 26.1 },
      ],
    });
    const relation = normalizeCatalogueElement({
      type: "relation",
      id: 11,
      tags: { leisure: "park", name: "Park" },
      members: [
        {
          type: "way",
          ref: 1,
          role: "outer",
          geometry: [
            { lat: 44.42, lon: 26.1 },
            { lat: 44.42, lon: 26.11 },
          ],
        },
      ],
    });

    expect(polygon.place?.geometry.type).toBe("Polygon");
    expect(relation.place).toMatchObject({ buildArea: true, geometry: { type: "MultiLineString" } });
  });

  it("rejects malformed/out-of-area elements and preserves valid open ways", () => {
    expect(normalizeCatalogueElement({
      type: "node", id: 1, lat: 44.43, lon: 26.1, tags: { amenity: "cafe" },
    })).toEqual({ dropReason: "unclassified" });
    expect(normalizeCatalogueElement({
      type: "node", id: 0, lat: 44.43, lon: 26.1, tags: { amenity: "pharmacy" },
    })).toEqual({ dropReason: "invalid_identity" });
    expect(normalizeCatalogueElement({
      type: "node", id: 2, tags: { amenity: "pharmacy" },
    })).toEqual({ dropReason: "invalid_geometry" });
    expect(normalizeCatalogueElement({
      type: "node", id: 3, lat: 40, lon: 20, tags: { amenity: "pharmacy" },
    })).toEqual({ dropReason: "outside_bounds" });
    expect(normalizeCatalogueElement({
      type: "relation", id: 4, tags: { leisure: "park", name: "Empty relation" }, members: [],
    })).toEqual({ dropReason: "invalid_geometry" });

    const openWay = normalizeCatalogueElement({
      type: "way",
      id: 5,
      timestamp: "2026-07-20T00:00:00Z",
      tags: { amenity: "school", name: "Open campus", access: "public" },
      geometry: [
        { lat: 44.42, lon: 26.1 },
        { lat: 44.43, lon: 26.11 },
      ],
    });
    expect(openWay.place).toMatchObject({
      accessState: "public",
      geometry: { type: "LineString" },
      sourceUpdatedAt: new Date("2026-07-20T00:00:00Z"),
    });
  });

  it("never admits a lifecycle-tagged classified node (property)", () => {
    const categoryTags = fc.constantFrom<Record<string, string>>(
      { shop: "supermarket" },
      { amenity: "pharmacy" },
      { leisure: "park", name: "Park" },
      { amenity: "school" },
      { highway: "bus_stop" },
    );
    fc.assert(
      fc.property(categoryTags, fc.integer({ min: 1, max: 1_000_000 }), (tags, id) => {
        const result = normalizeCatalogueElement({
          type: "node",
          id,
          lat: 44.43,
          lon: 26.1,
          tags: { ...tags, abandoned: "yes" },
        });
        return result.dropReason === "lifecycle";
      }),
    );
  });
});
