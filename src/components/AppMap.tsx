"use client";

import { layers, namedFlavor } from "@protomaps/basemaps";
import maplibregl from "maplibre-gl";
import { Protocol } from "pmtiles";
import { useEffect, useRef, useState } from "react";

import "maplibre-gl/dist/maplibre-gl.css";

import { BUCHAREST_MAX_BOUNDS } from "@/lib/bounds";

// Piața Unirii — the classic Bucharest reference point.
const BUCHAREST_CENTER: [number, number] = [26.1025, 44.4268];

interface Ring {
  minutes: number;
  geometry: unknown;
}
interface GeoPoint {
  lat: number;
  lng: number;
  label: string;
}

// Sequential teal ramp (inner = brightest), drawn largest-first so the 15-min
// core sits on top. Chosen to read clearly over the dark basemap.
const RINGS = [
  { minutes: 45, fill: "#0d5c55", line: "#2dd4bf" },
  { minutes: 30, fill: "#0f766e", line: "#5eead4" },
  { minutes: 15, fill: "#14b8a6", line: "#99f6e4" },
] as const;

const EMPTY_FC = { type: "FeatureCollection" as const, features: [] as unknown[] };

type Status = "idle" | "loading" | "error";
type SelectInput = { kind: "search"; query: string } | { kind: "click"; lat: number; lng: number };

export default function AppMap() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const selectRef = useRef<((input: SelectInput) => void) | null>(null);
  const tokenRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const [query, setQuery] = useState("");
  const [label, setLabel] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    // Non-null capture so nested closures (renderSelection, load) keep the type.
    const el: HTMLDivElement = container;

    const protocol = new Protocol();
    maplibregl.addProtocol("pmtiles", protocol.tile);

    const map = new maplibregl.Map({
      container,
      style: {
        version: 8,
        glyphs: "https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf",
        sprite: "https://protomaps.github.io/basemaps-assets/sprites/v4/dark",
        sources: {
          protomaps: {
            type: "vector",
            url: `pmtiles://${window.location.origin}/api/tiles`,
            attribution:
              '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
          },
        },
        layers: layers("protomaps", namedFlavor("dark"), { lang: "en" }),
      },
      center: BUCHAREST_CENTER,
      zoom: 11.5,
      maxBounds: BUCHAREST_MAX_BOUNDS,
      attributionControl: { compact: false },
    });
    mapRef.current = map;

    function renderSelection(point: GeoPoint, rings: Ring[]) {
      const source = map.getSource("isochrone") as maplibregl.GeoJSONSource | undefined;
      source?.setData({
        type: "FeatureCollection",
        features: rings.map((r) => ({
          type: "Feature",
          properties: { minutes: r.minutes },
          geometry: r.geometry as GeoJSON.Geometry,
        })),
      } as GeoJSON.FeatureCollection);

      if (!markerRef.current) markerRef.current = new maplibregl.Marker({ color: "#2dd4bf" });
      markerRef.current.setLngLat([point.lng, point.lat]).addTo(map);
      map.flyTo({ center: [point.lng, point.lat], zoom: 13, essential: true });

      el.dataset.selection = point.label;
      el.dataset.isochroneRings = String(rings.length);
    }

    async function select(input: SelectInput) {
      const token = ++tokenRef.current;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const { signal } = controller;
      const stale = () => token !== tokenRef.current;

      const fail = (msg: string) => {
        if (stale()) return;
        setStatus("error");
        setMessage(msg);
      };

      setStatus("loading");
      setMessage(null);

      try {
        const pointUrl =
          input.kind === "search"
            ? `/api/geocode?q=${encodeURIComponent(input.query)}`
            : `/api/reverse?lat=${input.lat}&lng=${input.lng}`;
        const pointRes = await fetch(pointUrl, { signal });
        if (stale()) return;
        if (pointRes.status === 404) return fail("No place found there.");
        if (pointRes.status === 422) return fail("That spot is outside Bucharest.");
        if (!pointRes.ok) return fail("Could not look that up. Try again.");
        const point = (await pointRes.json()) as GeoPoint;

        const isoRes = await fetch(`/api/isochrone?lat=${point.lat}&lng=${point.lng}`, { signal });
        if (stale()) return;
        if (!isoRes.ok) return fail("Could not compute walking reach. Try again.");
        const iso = (await isoRes.json()) as { rings: Ring[] };
        if (stale()) return;

        renderSelection(point, iso.rings);
        setLabel(point.label);
        setStatus("idle");
      } catch (err) {
        if ((err as Error)?.name === "AbortError" || stale()) return;
        fail("Something went wrong. Try again.");
      }
    }

    selectRef.current = select;

    map.on("load", () => {
      map.addSource("isochrone", { type: "geojson", data: EMPTY_FC as GeoJSON.FeatureCollection });
      for (const ring of RINGS) {
        const filter = ["==", ["get", "minutes"], ring.minutes] as maplibregl.FilterSpecification;
        map.addLayer({
          id: `iso-fill-${ring.minutes}`,
          type: "fill",
          source: "isochrone",
          filter,
          paint: { "fill-color": ring.fill, "fill-opacity": 0.22 },
        });
        map.addLayer({
          id: `iso-line-${ring.minutes}`,
          type: "line",
          source: "isochrone",
          filter,
          paint: { "line-color": ring.line, "line-width": 1.5, "line-opacity": 0.9 },
        });
      }
      el.dataset.mapLoaded = "true";
    });

    map.on("click", (e) => selectRef.current?.({ kind: "click", lat: e.lngLat.lat, lng: e.lngLat.lng }));

    return () => {
      abortRef.current?.abort();
      map.remove();
      maplibregl.removeProtocol("pmtiles");
      mapRef.current = null;
    };
  }, []);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (q) selectRef.current?.({ kind: "search", query: q });
  }

  return (
    <div className="absolute inset-0">
      <div ref={containerRef} data-testid="app-map" className="h-full w-full" />

      {/* Search + status overlay. pointer-events-none wrapper; interactive bits opt back in. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex flex-col items-center gap-2 px-4 pt-20 sm:pt-24">
        <form onSubmit={onSubmit} className="pointer-events-auto flex w-full max-w-md gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search a Bucharest address — or click the map"
            aria-label="Search a Bucharest address"
            className="w-full rounded-full border border-white/15 bg-black/50 px-4 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-500 backdrop-blur focus:border-teal-300/60 focus:outline-none"
          />
          <button
            type="submit"
            disabled={status === "loading"}
            className="rounded-full bg-teal-400/90 px-4 py-2.5 text-sm font-medium text-zinc-950 transition-colors hover:bg-teal-300 disabled:opacity-50"
          >
            {status === "loading" ? "…" : "Go"}
          </button>
        </form>

        {(label || message) && (
          <div className="pointer-events-auto flex max-w-md flex-col items-center gap-1 rounded-2xl border border-white/10 bg-black/50 px-4 py-2 text-center backdrop-blur">
            {message ? (
              <p className="text-sm text-amber-300">{message}</p>
            ) : (
              <>
                <p className="line-clamp-2 text-sm text-zinc-200">{label}</p>
                <div className="flex items-center gap-3 text-xs text-zinc-400">
                  {RINGS.map((r) => (
                    <span key={r.minutes} className="flex items-center gap-1.5">
                      <span className="inline-block h-2 w-2 rounded-full" style={{ background: r.line }} />
                      {r.minutes} min
                    </span>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
