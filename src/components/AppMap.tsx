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
interface Suggestion {
  label: string;
  lat: number;
  lng: number;
}

const MIN_SUGGEST_LEN = 3;
const SUGGEST_DEBOUNCE_MS = 250;

type Mode = "walk" | "transit";

// Per-mode sequential ramps (inner = brightest), drawn largest-first so the
// 15-min core sits on top. Walk = teal, Transit = violet — a strong contrast on
// the dark basemap so toggling modes reads instantly. Colors are carried on each
// GeoJSON feature (see renderSelection) so one set of layers serves both modes.
const RAMPS: Record<Mode, Record<number, { fill: string; line: string }>> = {
  walk: {
    45: { fill: "#0d5c55", line: "#2dd4bf" },
    30: { fill: "#0f766e", line: "#5eead4" },
    15: { fill: "#14b8a6", line: "#99f6e4" },
  },
  transit: {
    45: { fill: "#4c1d95", line: "#a78bfa" },
    30: { fill: "#6d28d9", line: "#c4b5fd" },
    15: { fill: "#8b5cf6", line: "#ede9fe" },
  },
};
// Draw order: largest first so smaller (brighter) rings sit on top.
const RING_MINUTES = [45, 30, 15] as const;
const MARKER_COLOR: Record<Mode, string> = { walk: "#2dd4bf", transit: "#a78bfa" };
const MODE_LABEL: Record<Mode, string> = { walk: "Walking", transit: "Public transport" };

const EMPTY_FC = { type: "FeatureCollection" as const, features: [] as unknown[] };

type Status = "idle" | "loading" | "error";
type SelectInput =
  | { kind: "search"; query: string }
  | { kind: "click"; lat: number; lng: number }
  | { kind: "point"; lat: number; lng: number; label: string };

export default function AppMap() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const selectRef = useRef<((input: SelectInput) => void) | null>(null);
  const tokenRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const modeRef = useRef<Mode>("walk");
  // The last successfully-resolved origin+label, so toggling Walk/Transit
  // recomputes the same point in the new mode with no geocode/reverse round-trip.
  const lastSelectionRef = useRef<{ lat: number; lng: number; label: string } | null>(null);
  const suggestGenRef = useRef(0);
  const suggestAbortRef = useRef<AbortController | null>(null);
  const suppressSuggestRef = useRef(false);

  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<Mode>("walk");
  const [label, setLabel] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [suggestState, setSuggestState] = useState<"idle" | "loading" | "error">("idle");

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
    let pending: { origin: { lat: number; lng: number }; label: string; rings: Ring[]; mode: Mode } | null =
      null;

    function renderSelection(
      origin: { lat: number; lng: number },
      label: string,
      rings: Ring[],
      mode: Mode,
    ) {
      if (!styleLoaded) {
        pending = { origin, label, rings, mode };
        return;
      }
      const ramp = RAMPS[mode];
      const source = map.getSource("isochrone") as maplibregl.GeoJSONSource | undefined;
      source?.setData({
        type: "FeatureCollection",
        // Carry the per-mode colors on each feature so the shared layers paint
        // via ["get","fillColor"]/["get","lineColor"] — one layer set, two ramps.
        features: rings.map((r) => ({
          type: "Feature",
          properties: {
            minutes: r.minutes,
            fillColor: ramp[r.minutes]?.fill,
            lineColor: ramp[r.minutes]?.line,
          },
          geometry: r.geometry as GeoJSON.Geometry,
        })),
      } as GeoJSON.FeatureCollection);

      // Recreate the marker so its color matches the active mode.
      markerRef.current?.remove();
      markerRef.current = new maplibregl.Marker({ color: MARKER_COLOR[mode] });
      // Marker sits at the isochrone's rounded origin (T9) so it matches the rings.
      markerRef.current.setLngLat([origin.lng, origin.lat]).addTo(map);
      map.flyTo({ center: [origin.lng, origin.lat], zoom: 13, essential: true });

      el.dataset.selection = label;
      el.dataset.isochroneRings = String(rings.length);
      el.dataset.mode = mode;
    }

    function clearSelection() {
      pending = null;
      (map.getSource("isochrone") as maplibregl.GeoJSONSource | undefined)?.setData(
        EMPTY_FC as GeoJSON.FeatureCollection,
      );
      markerRef.current?.remove();
      delete el.dataset.selection;
      delete el.dataset.isochroneRings;
      delete el.dataset.mode;
    }

    async function select(input: SelectInput) {
      // Capture the mode ONCE at the start so this response's endpoint, colors,
      // legend and data-mode all agree even if the user toggles mid-flight.
      const mode = modeRef.current;
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
      // Forget the prior resolved origin until THIS selection resolves, so a
      // mode toggle mid-flight can't recompute a stale/previous address.
      lastSelectionRef.current = null;
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
        } else if (input.kind === "point") {
          // A picked autocomplete suggestion: point + label already resolved —
          // go straight to the isochrone, NO geocode/reverse round-trip.
          origin = { lat: input.lat, lng: input.lng };
          label = input.label;
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

        const isoPath = mode === "transit" ? "/api/transit" : "/api/isochrone";
        const isoRes = await fetch(`${isoPath}?lat=${origin.lat}&lng=${origin.lng}`, { signal });
        if (stale()) return;
        if (isoRes.status === 422) return fail("That spot is outside Bucharest.");
        if (!isoRes.ok) return fail(`Could not compute ${mode === "transit" ? "transit" : "walking"} reach. Try again.`);
        const iso = (await isoRes.json()) as { origin: { lat: number; lng: number }; rings: Ring[] };
        if (stale()) return;

        // Remember the resolved origin so a mode toggle recomputes it directly.
        lastSelectionRef.current = { lat: iso.origin.lat, lng: iso.origin.lng, label };
        renderSelection(iso.origin, label, iso.rings, mode);
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
      for (const minutes of RING_MINUTES) {
        const filter = ["==", ["get", "minutes"], minutes] as maplibregl.FilterSpecification;
        map.addLayer({
          id: `iso-fill-${minutes}`,
          type: "fill",
          source: "isochrone",
          filter,
          // Color comes from the feature (per-mode ramp) so both modes reuse these layers.
          paint: { "fill-color": ["get", "fillColor"], "fill-opacity": 0.22 },
        });
        map.addLayer({
          id: `iso-line-${minutes}`,
          type: "line",
          source: "isochrone",
          filter,
          paint: { "line-color": ["get", "lineColor"], "line-width": 1.5, "line-opacity": 0.9 },
        });
      }
      styleLoaded = true;
      if (pending) {
        const p = pending;
        pending = null;
        renderSelection(p.origin, p.label, p.rings, p.mode);
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

  // Debounced type-ahead: fetch suggestions as the user types. A generation
  // token + AbortController make sure a slow response for an old query can't
  // repopulate the dropdown, and <3 chars issues no request.
  useEffect(() => {
    const q = query.trim();
    suggestAbortRef.current?.abort();
    // A programmatic query change (picking a suggestion) must not re-fetch.
    if (suppressSuggestRef.current) {
      suppressSuggestRef.current = false;
      return;
    }
    if (q.length < MIN_SUGGEST_LEN) return; // clearing handled in onQueryChange
    const gen = ++suggestGenRef.current;
    const controller = new AbortController();
    suggestAbortRef.current = controller;
    const timer = setTimeout(async () => {
      setSuggestState("loading");
      setSuggestOpen(true);
      try {
        const res = await fetch(`/api/suggest?q=${encodeURIComponent(q)}`, { signal: controller.signal });
        if (gen !== suggestGenRef.current) return;
        if (!res.ok) {
          // A provider/upstream error is NOT the same as "no matches".
          setSuggestions([]);
          setSuggestState("error");
          return;
        }
        const data = (await res.json()) as { suggestions: Suggestion[] };
        if (gen !== suggestGenRef.current) return;
        setSuggestions(data.suggestions);
        setActiveIndex(-1);
        setSuggestState("idle");
      } catch {
        /* aborted (superseded/blur) → leave state to the newer run */
      }
    }, SUGGEST_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  function onQueryChange(value: string) {
    suppressSuggestRef.current = false; // a real user edit always re-enables suggesting
    suggestGenRef.current += 1; // invalidate any in-flight response synchronously
    suggestAbortRef.current?.abort();
    setQuery(value);
    if (value.trim().length < MIN_SUGGEST_LEN) {
      setSuggestions([]);
      setSuggestOpen(false);
      setActiveIndex(-1);
      setSuggestState("idle");
    }
  }

  function closeSuggest() {
    suggestGenRef.current += 1; // invalidate any in-flight response
    suggestAbortRef.current?.abort();
    setSuggestOpen(false);
    setActiveIndex(-1);
  }

  function switchMode(next: Mode) {
    if (next === modeRef.current) return;
    modeRef.current = next;
    setMode(next);
    // Invalidate any in-flight select so a walk response can't land under a
    // transit toggle (or vice-versa) and mislabel the rings.
    tokenRef.current += 1;
    abortRef.current?.abort();
    // Recompute the current point in the new mode — no geocode/reverse.
    const last = lastSelectionRef.current;
    if (last) {
      selectRef.current?.({ kind: "point", lat: last.lat, lng: last.lng, label: last.label });
    } else {
      // No resolved selection to recompute. If we just aborted an in-flight
      // search, don't strand the UI in "loading" — return it to idle.
      setStatus("idle");
      setMessage(null);
    }
  }

  function pickSuggestion(s: Suggestion) {
    closeSuggest();
    setSuggestions([]);
    suppressSuggestRef.current = true; // the setQuery below must not re-open suggestions
    setQuery(s.label);
    selectRef.current?.({ kind: "point", lat: s.lat, lng: s.lng, label: s.label });
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (suggestOpen && activeIndex >= 0 && suggestions[activeIndex]) {
      pickSuggestion(suggestions[activeIndex]);
      return;
    }
    const q = query.trim();
    if (q) {
      closeSuggest();
      selectRef.current?.({ kind: "search", query: q });
    }
  }

  function onSearchKeyDown(e: React.KeyboardEvent) {
    if (!suggestOpen || suggestions.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % suggestions.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
    } else if (e.key === "Escape") {
      closeSuggest();
    }
    // Enter is handled by the form's onSubmit (which picks the active option).
  }

  return (
    <div className="absolute inset-0">
      <div ref={containerRef} data-testid="app-map" className="h-full w-full" />

      {/* Search + status overlay. pointer-events-none wrapper; interactive bits opt back in. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex flex-col items-center gap-2 px-4 pt-20 sm:pt-24">
        <form onSubmit={onSubmit} className="pointer-events-auto flex w-full max-w-md gap-2">
          <input
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={onSearchKeyDown}
            onBlur={closeSuggest}
            onFocus={() => suggestions.length > 0 && setSuggestOpen(true)}
            placeholder="Search a Bucharest address — or click the map"
            aria-label="Search a Bucharest address"
            role="combobox"
            aria-expanded={suggestOpen}
            aria-controls="suggest-list"
            aria-activedescendant={activeIndex >= 0 ? `suggest-opt-${activeIndex}` : undefined}
            autoComplete="off"
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

        {/* Travel-mode toggle: recomputes the current point in the chosen mode. */}
        <div
          role="group"
          aria-label="Travel mode"
          className="pointer-events-auto flex gap-1 rounded-full border border-white/15 bg-black/50 p-1 backdrop-blur"
        >
          {(["walk", "transit"] as Mode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => switchMode(m)}
              aria-pressed={mode === m}
              className={`rounded-full px-5 py-1.5 text-sm font-medium transition-colors ${
                mode === m
                  ? m === "walk"
                    ? "bg-teal-400/90 text-zinc-950"
                    : "bg-violet-400/90 text-zinc-950"
                  : "text-zinc-300 hover:text-zinc-100"
              }`}
            >
              {m === "walk" ? "Walk" : "Transit"}
            </button>
          ))}
        </div>

        {suggestOpen && query.trim().length >= MIN_SUGGEST_LEN && (
          <ul
            id="suggest-list"
            role="listbox"
            className="pointer-events-auto w-full max-w-md overflow-hidden rounded-2xl border border-white/10 bg-black/70 backdrop-blur"
          >
            {suggestState === "loading" ? (
              <li className="px-4 py-2.5 text-sm text-zinc-500">Searching…</li>
            ) : suggestState === "error" ? (
              <li className="px-4 py-2.5 text-sm text-amber-300">Couldn’t load suggestions. Try again.</li>
            ) : suggestions.length === 0 ? (
              <li className="px-4 py-2.5 text-sm text-zinc-500">No matches in Bucharest</li>
            ) : (
              suggestions.map((s, i) => (
                <li
                  key={`${s.lat},${s.lng},${i}`}
                  id={`suggest-opt-${i}`}
                  role="option"
                  aria-selected={i === activeIndex}
                  onPointerDown={(e) => {
                    e.preventDefault(); // keep focus so the pick runs before blur (mouse + touch)
                    pickSuggestion(s);
                  }}
                  onMouseEnter={() => setActiveIndex(i)}
                  className={`cursor-pointer px-4 py-2.5 text-sm ${
                    i === activeIndex ? "bg-teal-400/20 text-zinc-50" : "text-zinc-200"
                  }`}
                >
                  {s.label}
                </li>
              ))
            )}
          </ul>
        )}

        {(label || message) && (
          <div className="pointer-events-auto flex max-w-md flex-col items-center gap-1 rounded-2xl border border-white/10 bg-black/50 px-4 py-2 text-center backdrop-blur">
            {message ? (
              <p className="text-sm text-amber-300">{message}</p>
            ) : (
              <>
                <p className="line-clamp-2 text-sm text-zinc-200">{label}</p>
                <div className="flex items-center gap-3 text-xs text-zinc-400">
                  <span className="font-medium text-zinc-300">{MODE_LABEL[mode]}</span>
                  {[15, 30, 45].map((m) => (
                    <span key={m} className="flex items-center gap-1.5">
                      <span
                        className="inline-block h-2 w-2 rounded-full"
                        style={{ background: RAMPS[mode][m].line }}
                      />
                      {m} min
                    </span>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Data attribution — Transitous ToS requires a visible link to its sources
          (basemap © OSM is shown by the MapLibre attribution control). */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center px-4 pb-9 sm:pb-7">
        <p className="pointer-events-auto rounded-full border border-white/10 bg-black/50 px-3 py-1 text-[11px] text-zinc-400 backdrop-blur">
          Transit data ©{" "}
          <a
            href="https://transitous.org/sources/"
            target="_blank"
            rel="noreferrer"
            className="text-violet-300 underline decoration-dotted underline-offset-2 hover:text-violet-200"
          >
            Transitous
          </a>
        </p>
      </div>
    </div>
  );
}
