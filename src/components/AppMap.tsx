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

    // Buffer the latest selection until the style (and isochrone source/layers)
    // exist — a search that resolves before `load` would otherwise drop its rings.
    let styleLoaded = false;
    let pending: { origin: { lat: number; lng: number }; label: string; rings: Ring[] } | null = null;

    function renderSelection(origin: { lat: number; lng: number }, label: string, rings: Ring[]) {
      if (!styleLoaded) {
        pending = { origin, label, rings };
        return;
      }
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
      // Marker sits at the isochrone's rounded origin (T9) so it matches the rings.
      markerRef.current.setLngLat([origin.lng, origin.lat]).addTo(map);
      map.flyTo({ center: [origin.lng, origin.lat], zoom: 13, essential: true });

      el.dataset.selection = label;
      el.dataset.isochroneRings = String(rings.length);
    }

    function clearSelection() {
      pending = null;
      (map.getSource("isochrone") as maplibregl.GeoJSONSource | undefined)?.setData(
        EMPTY_FC as GeoJSON.FeatureCollection,
      );
      markerRef.current?.remove();
      delete el.dataset.selection;
      delete el.dataset.isochroneRings;
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

      clearSelection(); // M7: drop the previous marker/rings the moment a new selection starts
      setLabel(null);
      setStatus("loading");
      setMessage(null);

      try {
        // Resolve the origin (what ORS + the marker use) and its label.
        let origin: { lat: number; lng: number };
        let label: string;

        if (input.kind === "search") {
          const res = await fetch(`/api/geocode?q=${encodeURIComponent(input.query)}`, { signal });
          if (stale()) return;
          if (res.status === 404) return fail("No place found there.");
          if (res.status === 422) return fail("That spot is outside Bucharest.");
          if (!res.ok) return fail("Could not look that up. Try again.");
          const point = (await res.json()) as GeoPoint;
          origin = { lat: point.lat, lng: point.lng };
          label = point.label;
        } else {
          // A map click: the origin IS the clicked point (not a reverse-geocoded
          // centroid); reverse geocoding only supplies the human-readable label.
          origin = { lat: input.lat, lng: input.lng };
          label = "Selected point";
          const res = await fetch(`/api/reverse?lat=${input.lat}&lng=${input.lng}`, { signal });
          if (stale()) return;
          if (res.status === 422) return fail("That spot is outside Bucharest.");
          if (res.ok) label = ((await res.json()) as GeoPoint).label;
          // 404 (no address there) → keep the generic label but still show the reach.
        }

        const isoRes = await fetch(`/api/isochrone?lat=${origin.lat}&lng=${origin.lng}`, { signal });
        if (stale()) return;
        if (isoRes.status === 422) return fail("That spot is outside Bucharest.");
        if (!isoRes.ok) return fail("Could not compute walking reach. Try again.");
        const iso = (await isoRes.json()) as { origin: { lat: number; lng: number }; rings: Ring[] };
        if (stale()) return;

        renderSelection(iso.origin, label, iso.rings);
        setLabel(label);
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
      styleLoaded = true;
      if (pending) {
        const p = pending;
        pending = null;
        renderSelection(p.origin, p.label, p.rings);
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
