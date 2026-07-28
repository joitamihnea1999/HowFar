import { layers, namedFlavor } from "@protomaps/basemaps";
import { describe, expect, it } from "vitest";

import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";

import { AMENITY_CATEGORIES, UNKNOWN_DISTANCE_SORT } from "@/features/amenities/amenities";
import {
  AMENITY_SOURCE_MAX_ZOOM,
  CLUSTER_MAX_ZOOM,
  CLUSTER_RADIUS_PX,
  pinRadiusHoverExpression,
} from "@/features/amenities/amenity-cluster";
import { amenityIconImageExpression } from "@/features/amenities/amenity-icons";
import { RING_BANDS } from "@/features/isochrones/isochrone-view";

import {
  addAmenityLayers,
  addAmenitySpiderLayers,
  addIsochroneLayers,
  addRoutePathLayers,
  AMENITY_LABEL_MINZOOM,
  SPIDER_ICON_LAYER,
  SPIDER_LABEL_LAYER,
  SPIDER_LEG_LAYER,
  SPIDER_MARKER_LAYER,
  SPIDER_SOURCE,
  createMapStyle,
  EMPTY_FC,
  ISOCHRONE_FILL_OPACITY,
  ISOCHRONE_LINE_OPACITY,
  ROUTE_PATH_COLOR,
} from "./map-setup";

/** Recording stub for the addSource/addLayer slice the helpers touch. */
function recorder() {
  const sources: [string, Record<string, unknown>][] = [];
  const layerSpecs: Record<string, unknown>[] = [];
  const host = {
    addSource: (id: string, s: unknown) => void sources.push([id, s as Record<string, unknown>]),
    addLayer: (l: unknown) => void layerSpecs.push(l as Record<string, unknown>),
  } as unknown as Parameters<typeof addIsochroneLayers>[0];
  return { host, sources, layerSpecs };
}

describe("createMapStyle", () => {
  it("builds a v8 style serving the given tiles URL through the pmtiles protocol", () => {
    const style = createMapStyle("http://localhost:8080/api/tiles");
    expect(style.version).toBe(8);
    const protomaps = (style.sources as Record<string, { type?: string; url?: string; attribution?: string }>)
      .protomaps;
    expect(protomaps.type).toBe("vector");
    expect(protomaps.url).toBe("pmtiles://http://localhost:8080/api/tiles");
    expect(protomaps.attribution).toContain("openstreetmap.org/copyright");
  });

  it("uses the protomaps-hosted glyphs and dark sprite, with exactly the dark/en basemap stack", () => {
    const style = createMapStyle("https://example.com/api/tiles");
    expect(style.glyphs).toBe("https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf");
    expect(style.sprite).toBe("https://protomaps.github.io/basemaps-assets/sprites/v4/dark");
    // Pin the flavor and label language, not just non-emptiness: switching to
    // another namedFlavor or language must fail here.
    expect(style.layers).toEqual(layers("protomaps", namedFlavor("dark"), { lang: "en" }));
  });

  it("is pure: two calls with different URLs do not share state", () => {
    const a = createMapStyle("http://a/api/tiles");
    const b = createMapStyle("http://b/api/tiles");
    expect((a.sources as Record<string, { url?: string }>).protomaps.url).toBe("pmtiles://http://a/api/tiles");
    expect((b.sources as Record<string, { url?: string }>).protomaps.url).toBe("pmtiles://http://b/api/tiles");
  });
});

describe("addIsochroneLayers", () => {
  it("adds one empty geojson source and a fill+line layer pair per ring, filtered by band", () => {
    const { host, sources, layerSpecs } = recorder();
    addIsochroneLayers(host);

    expect(sources).toEqual([["isochrone", { type: "geojson", data: EMPTY_FC }]]);
    expect(layerSpecs.map((l) => l.id)).toEqual(
      RING_BANDS.flatMap((b) => [`iso-fill-${b}`, `iso-line-${b}`]),
    );

    for (const band of RING_BANDS) {
      const fill = layerSpecs.find((l) => l.id === `iso-fill-${band}`);
      const line = layerSpecs.find((l) => l.id === `iso-line-${band}`);
      const filter = ["==", ["get", "band"], band];
      expect(fill).toEqual({
        id: `iso-fill-${band}`,
        type: "fill",
        source: "isochrone",
        filter,
        paint: {
          "fill-color": ["get", "fillColor"],
          "fill-opacity": ISOCHRONE_FILL_OPACITY,
          "fill-opacity-transition": { duration: 320, delay: 0 },
        },
      });
      expect(line).toEqual({
        id: `iso-line-${band}`,
        type: "line",
        source: "isochrone",
        filter,
        paint: {
          "line-color": ["get", "lineColor"],
          "line-width": 2,
          "line-opacity": ISOCHRONE_LINE_OPACITY,
          "line-opacity-transition": { duration: 320, delay: 0 },
        },
      });
    }
  });
});

describe("layer composition", () => {
  it("draws route path above isochrone fills but UNDER the amenity marks (documented order)", () => {
    const { host, layerSpecs } = recorder();
    addIsochroneLayers(host);
    addRoutePathLayers(host);
    addAmenityLayers(host);
    expect(layerSpecs.at(-1)?.id).toBe("amenity-labels");
    expect(layerSpecs.map((l) => l.id).slice(-7)).toEqual([
      "route-path-casing",
      "route-path-line",
      "route-path-stops",
      "route-path-labels",
      "amenity-markers",
      "amenity-icons",
      "amenity-labels",
    ]);
    expect(layerSpecs).toHaveLength(RING_BANDS.length * 2 + 7);
  });
});

describe("addRoutePathLayers", () => {
  it("adds one source with casing+line for track and ringed dots for stops, split by geometry type", () => {
    const { host, sources, layerSpecs } = recorder();
    addRoutePathLayers(host);

    expect(sources).toEqual([["route-path", { type: "geojson", data: EMPTY_FC }]]);
    const isLine = ["==", ["geometry-type"], "LineString"];
    expect(layerSpecs).toEqual([
      {
        id: "route-path-casing",
        type: "line",
        source: "route-path",
        filter: isLine,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#09090b", "line-width": 8, "line-opacity": 0.88 },
      },
      {
        id: "route-path-line",
        type: "line",
        source: "route-path",
        filter: isLine,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": ROUTE_PATH_COLOR, "line-width": 3.5, "line-opacity": 0.97 },
      },
      {
        id: "route-path-stops",
        type: "circle",
        source: "route-path",
        filter: ["==", ["geometry-type"], "Point"],
        paint: {
          "circle-radius": 5,
          "circle-color": "#09090b",
          "circle-stroke-color": ROUTE_PATH_COLOR,
          "circle-stroke-width": 2,
        },
      },
      {
        id: "route-path-labels",
        type: "symbol",
        source: "route-path",
        filter: ["==", ["geometry-type"], "Point"],
        layout: {
          "text-field": ["get", "name"],
          "text-font": ["Noto Sans Medium"],
          "text-size": 11,
          "text-anchor": "top",
          "text-offset": [0, 0.7],
        },
        paint: {
          "text-color": ROUTE_PATH_COLOR,
          "text-halo-color": "#09090b",
          "text-halo-width": 1.5,
        },
      },
    ]);
  });
});

describe("addAmenityLayers", () => {
  it("clusters the source so aggregation NEVER dissolves, with per-category accumulators", () => {
    const { host, sources } = recorder();
    addAmenityLayers(host);

    expect(sources).toHaveLength(1);
    const [id, spec] = sources[0];
    expect(id).toBe("amenities");
    expect(spec.type).toBe("geojson");
    expect(spec.data).toBe(EMPTY_FC);
    expect(spec.cluster).toBe(true);
    expect(spec.clusterRadius).toBe(CLUSTER_RADIUS_PX);

    // The whole anti-overlap guarantee rests on these two numbers: clustering must
    // stay active all the way to the map's own maximum zoom, and the source's
    // maxzoom must be STRICTLY greater or MapLibre warns and stops clustering
    // early (source default 18 < map default 22 — so both must be explicit).
    expect(spec.clusterMaxZoom).toBe(CLUSTER_MAX_ZOOM);
    expect(spec.maxzoom).toBe(AMENITY_SOURCE_MAX_ZOOM);
    expect(spec.maxzoom as number).toBeGreaterThan(spec.clusterMaxZoom as number);

    // generateId is GONE: it is unavailable on a clustered source, so
    // buildAmenityFeatures emits explicit ids for the hover feature-state.
    expect(spec.generateId).toBeUndefined();

    // One accumulator per category, so a donut can report what kinds it holds.
    const props = spec.clusterProperties as Record<string, unknown>;
    expect(Object.keys(props).sort()).toEqual(AMENITY_CATEGORIES.map((c) => c.key).sort());
    for (const { key } of AMENITY_CATEGORIES) {
      expect(props[key]).toEqual(["+", ["case", ["==", ["get", "category"], key], 1, 0]]);
    }
  });

  it("splits every layer by cluster-vs-single so centroids never paint as places", () => {
    const { host, layerSpecs } = recorder();
    addAmenityLayers(host);

    const byId = Object.fromEntries(layerSpecs.map((l) => [l.id as string, l]));
    // No cluster layer exists: clusters are DOM donuts merged in screen space, and a
    // WebGL layer per SOURCE cluster re-exposed the un-merged positions.
    expect(byId["amenity-cluster-halo"]).toBeUndefined();
    for (const id of ["amenity-markers", "amenity-icons", "amenity-labels"]) {
      expect(byId[id].filter).toEqual(["!", ["has", "point_count"]]);
    }
  });

  it("scales pin radius with zoom from the shared stops, and grows on hover", () => {
    const { host, layerSpecs } = recorder();
    addAmenityLayers(host);
    const markers = layerSpecs.find((l) => l.id === "amenity-markers") as Record<string, Record<string, unknown>>;

    // A fixed radius at every zoom was one of the three causes of the original
    // crowding complaint. The expression comes from the same stops the pure
    // separation tests assert against, so rendering and proof cannot drift.
    expect(markers.paint["circle-radius"]).toEqual(pinRadiusHoverExpression());
    expect(markers.paint["circle-color"]).toEqual(["get", "color"]);
    expect(markers.paint["circle-stroke-color"]).toBe("#ffffff");
  });

  it("uses only ONE zoom-based subexpression per paint property", () => {
    // MapLibre rejects a paint property containing more than one zoom-based
    // interpolate/step, and `addLayer` THROWS — which silently drops the whole
    // layer. The first cut of this layer used
    // `["case", hover, <interpolate>, <interpolate>]` and every pin vanished; the
    // shape-only assertions above all still passed. Hence this test, and the
    // validator test below.
    const { host, layerSpecs } = recorder();
    addAmenityLayers(host);
    const countZoomInterps = (node: unknown): number => {
      if (!Array.isArray(node)) return 0;
      const self = node[0] === "interpolate" || node[0] === "step" ? 1 : 0;
      return self + node.reduce<number>((sum, child) => sum + countZoomInterps(child), 0);
    };
    for (const layer of layerSpecs) {
      for (const group of ["paint", "layout"] as const) {
        const props = (layer[group] ?? {}) as Record<string, unknown>;
        for (const [prop, value] of Object.entries(props)) {
          expect(countZoomInterps(value), `${layer.id as string}.${group}.${prop}`).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("produces a style MapLibre's own validator accepts (catches what shape assertions cannot)", () => {
    // The regression guard for the class of bug that shape assertions miss: an
    // expression can be structurally "as intended" and still be rejected at
    // addLayer time. Validating the real source+layer specs against the shipped
    // style-spec is the only unit-level check that would have caught it.
    const { host, sources, layerSpecs } = recorder();
    addIsochroneLayers(host);
    addRoutePathLayers(host);
    addAmenityLayers(host);
    addAmenitySpiderLayers(host);
    const style = {
      version: 8 as const,
      sources: Object.fromEntries(sources.map(([id, spec]) => [id, spec])),
      layers: layerSpecs,
    };
    const errors = validateStyleMin(style as never).filter(
      // Runtime-registered sprite images cannot be known to a static validator.
      (e) => !/image .*(does not exist|not found)/i.test(e.message),
    );
    expect(errors.map((e) => `${e.message}`)).toEqual([]);
  });

  it("draws the spiderfy fan ON TOP of the amenity layers it expands", () => {
    // A fan replaces the marks it came from; drawn underneath, its leaves would be
    // hidden by the very donut the user just expanded.
    const { host, layerSpecs } = recorder();
    addAmenityLayers(host);
    addAmenitySpiderLayers(host);
    expect(layerSpecs.map((l) => l.id)).toEqual([
      "amenity-markers",
      "amenity-icons",
      "amenity-labels",
      SPIDER_LEG_LAYER,
      SPIDER_MARKER_LAYER,
      SPIDER_ICON_LAYER,
      SPIDER_LABEL_LAYER,
    ]);
  });

  it("gives the fan its OWN unclustered source, or its offsets would re-cluster into the hub", () => {
    const { host, sources } = recorder();
    addAmenitySpiderLayers(host);
    expect(sources).toEqual([[SPIDER_SOURCE, { type: "geojson", data: EMPTY_FC }]]);
    // Emphatically NOT clustered: these features are screen-space offsets of places
    // that are already coincident, so clustering them would collapse the fan.
    expect(sources[0][1].cluster).toBeUndefined();
  });

  it("collision-manages fanned names, because pin separation is NOT label separation", () => {
    // The fan's geometry proof covers its PINS (25px apart), not their names: a long
    // POI name is far wider, so allowing overlap here reproduced exactly the text mud
    // the owner reported (reviewers). A dropped name is the lesser
    // harm — the pin still draws, the hub enumerates every member, and the list is one
    // keystroke away — and the sort key makes WHICH name drops deterministic.
    const { host, layerSpecs } = recorder();
    addAmenitySpiderLayers(host);
    const labels = layerSpecs.find((l) => l.id === SPIDER_LABEL_LAYER) as Record<
      string,
      Record<string, unknown>
    >;
    expect(labels.layout["text-allow-overlap"]).toBe(false);
    expect(labels.layout["text-ignore-placement"]).toBe(false);
    expect(labels.layout["text-optional"]).toBe(true);
    expect(labels.layout["symbol-sort-key"]).toBeDefined();
    // Still readable at every zoom, unlike the main map's labels.
    expect(labels.minzoom).toBeUndefined();
  });

  it("gives icons and NAMES opposite overlap policies — the fix for the mud in the report", () => {
    const { host, layerSpecs } = recorder();
    addAmenityLayers(host);
    const icons = layerSpecs.find((l) => l.id === "amenity-icons") as Record<string, Record<string, unknown>>;
    const labels = layerSpecs.find((l) => l.id === "amenity-labels") as Record<string, Record<string, unknown>>;

    // The icon must stay glued to its pin, so it may overlap...
    expect(icons.layout["icon-allow-overlap"]).toBe(true);
    expect(icons.layout["icon-ignore-placement"]).toBe(true);
    expect(icons.layout["icon-image"]).toEqual(amenityIconImageExpression());
    // Icons must be present at the map's opening zoom (11.5), not gated above it.
    expect(icons.minzoom).toBeUndefined();

    // ...but names must be collision-managed, or they overprint into the
    // "GG"/"+G+" mud the owner reported. The retired glyph layer had BOTH of
    // these set to true, which is exactly why it produced that.
    expect(labels.layout["text-allow-overlap"]).toBe(false);
    expect(labels.layout["text-ignore-placement"]).toBe(false);
    expect(labels.minzoom).toBe(AMENITY_LABEL_MINZOOM);
  });

  it("prioritises label placement by served distance, with a finite fallback", () => {
    const { host, layerSpecs } = recorder();
    addAmenityLayers(host);
    const labels = layerSpecs.find((l) => l.id === "amenity-labels") as Record<string, Record<string, unknown>>;

    // Lower sort key wins placement in MapLibre, so keying on distance means the
    // NEAREST places keep their names when labels must be thinned. The coalesce
    // guarantees the expression never resolves to undefined (which would make
    // placement order arbitrary).
    expect(labels.layout["symbol-sort-key"]).toEqual([
      "coalesce",
      ["get", "distanceSort"],
      UNKNOWN_DISTANCE_SORT,
    ]);
  });

  it("no longer registers the letter-glyph layer", () => {
    const { host, layerSpecs } = recorder();
    addAmenityLayers(host);
    expect(layerSpecs.map((l) => l.id)).not.toContain("amenity-glyphs");
  });
});
