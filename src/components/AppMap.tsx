"use client";

import { layers, namedFlavor } from "@protomaps/basemaps";
import maplibregl from "maplibre-gl";
import { Protocol } from "pmtiles";
import { useEffect, useRef, useState } from "react";

import "maplibre-gl/dist/maplibre-gl.css";

import { BUCHAREST_MAX_BOUNDS } from "@/lib/bounds";
import {
  buildIsochroneFeatures,
  legendColor,
  LEGEND_MINUTES,
  MARKER_COLOR,
  MODE_LABEL,
  RING_MINUTES,
} from "@/lib/isochrone-view";
import {
  comboboxReducer,
  initialComboboxState,
  MIN_SUGGEST_LEN,
  shouldFetchSuggest,
  type ComboboxAction,
  type ComboboxState,
  type Suggestion,
} from "@/lib/combobox";
import {
  initialSelectionState,
  isochronePath,
  reverseIsFatal,
  selectionReducer,
  type Mode,
  type Origin,
  type Ring,
  type SelectInput,
  type SelectionAction,
  type SelectionState,
} from "@/lib/selection-flow";

// Piața Unirii — the classic Bucharest reference point.
const BUCHAREST_CENTER: [number, number] = [26.1025, 44.4268];
const SUGGEST_DEBOUNCE_MS = 250;

interface GeoPoint {
  lat: number;
  lng: number;
  label: string;
}

const EMPTY_FC = { type: "FeatureCollection" as const, features: [] as unknown[] };

export default function AppMap() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const selectRef = useRef<((input: SelectInput, opts?: { recompute?: boolean }) => void) | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const suggestAbortRef = useRef<AbortController | null>(null);
  const suggestTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The two extracted state machines drive the render via useState, but each is
  // mirrored in a ref so a dispatch can be read back synchronously in the same
  // tick (fresh token/generation) from the imperative fetch orchestration —
  // see lib/selection-flow and lib/combobox. Render reads the state; callbacks
  // read the ref.
  const [selState, setSelState] = useState<SelectionState>(initialSelectionState);
  const [comboState, setComboState] = useState<ComboboxState>(initialComboboxState);
  const selRef = useRef<SelectionState>(initialSelectionState);
  const comboRef = useRef<ComboboxState>(initialComboboxState);

  function dispatchSel(action: SelectionAction): SelectionState {
    const next = selectionReducer(selRef.current, action);
    if (next !== selRef.current) {
      selRef.current = next;
      setSelState(next);
    }
    return next;
  }
  function dispatchCombo(action: ComboboxAction): ComboboxState {
    const next = comboboxReducer(comboRef.current, action);
    if (next !== comboRef.current) {
      comboRef.current = next;
      setComboState(next);
    }
    return next;
  }

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
    let pending: { origin: Origin; label: string; rings: Ring[]; mode: Mode } | null = null;

    function renderSelection(origin: Origin, label: string, rings: Ring[], mode: Mode) {
      if (!styleLoaded) {
        pending = { origin, label, rings, mode };
        return;
      }
      const source = map.getSource("isochrone") as maplibregl.GeoJSONSource | undefined;
      source?.setData({
        type: "FeatureCollection",
        features: buildIsochroneFeatures(rings, mode),
      });

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

    async function select(input: SelectInput, opts?: { recompute?: boolean }) {
      // Snapshot the mode ONCE (from the selection machine) so this response's
      // endpoint, colors, legend and data-mode all agree even if the user
      // toggles mid-flight; `start` bumps the token that guards staleness. A
      // toggle-driven recompute preserves lastSelection so a further toggle
      // before it resolves can still recover the origin.
      const mode = selRef.current.mode;
      const { token } = dispatchSel({ type: "start", mode, preserveLast: opts?.recompute });
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const { signal } = controller;
      const stale = () => token !== selRef.current.token;

      clearSelection(); // drop the previous marker/rings the moment a new selection starts

      try {
        // Resolve the origin (what the isochrone + marker use) and its label.
        let origin: Origin;
        let label: string;

        if (input.kind === "search") {
          const res = await fetch(`/api/geocode?q=${encodeURIComponent(input.query)}`, { signal });
          if (stale()) return;
          if (!res.ok) return void dispatchSel({ type: "failed", token, stage: "geocode", httpStatus: res.status });
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
          // Only out-of-area is fatal; a missing/errored address keeps the
          // generic label and still shows the reach.
          if (reverseIsFatal(res.status))
            return void dispatchSel({ type: "failed", token, stage: "reverse", httpStatus: res.status });
          if (res.ok) {
            // A malformed body is non-fatal: keep the generic label and still
            // show the reach, matching the reverse-non-fatal contract. Guard
            // both a parse error AND a valid-but-wrong-shape body (missing or
            // non-string label).
            try {
              const body = (await res.json()) as { label?: unknown };
              if (typeof body.label === "string" && body.label.trim()) label = body.label;
            } catch {
              /* keep "Selected point" */
            }
          }
        }

        const isoRes = await fetch(`${isochronePath(mode)}?lat=${origin.lat}&lng=${origin.lng}`, { signal });
        if (stale()) return;
        if (!isoRes.ok) return void dispatchSel({ type: "failed", token, stage: "isochrone", httpStatus: isoRes.status });
        const iso = (await isoRes.json()) as { origin: Origin; rings: Ring[] };
        if (stale()) return;

        // Fresh (stale() just checked): accept and paint. Reducer records the
        // isochrone's rounded origin so a mode toggle recomputes the same point.
        dispatchSel({ type: "resolved", token, origin: iso.origin, label });
        renderSelection(iso.origin, label, iso.rings, mode);
      } catch (err) {
        if ((err as Error)?.name === "AbortError" || stale()) return;
        dispatchSel({ type: "crash", token });
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
      suggestAbortRef.current?.abort();
      if (suggestTimerRef.current) clearTimeout(suggestTimerRef.current);
      map.remove();
      maplibregl.removeProtocol("pmtiles");
      mapRef.current = null;
    };
  }, []);

  // --- Combobox (autocomplete) wiring: the debounce timer + AbortController are
  // imperative; the combobox reducer owns the transitions. Every fetch tags
  // itself with the generation current when it was scheduled so a superseded
  // response (or one after close/pick) is dropped by the reducer.
  function runSuggest(generation: number, q: string) {
    // Defensive: a timer is always cleared before a new one is set, so this
    // should already hold — but never disturb a newer request's in-flight fetch.
    if (generation !== comboRef.current.generation) return;
    dispatchCombo({ type: "fetchStarted", generation });
    suggestAbortRef.current?.abort();
    const controller = new AbortController();
    suggestAbortRef.current = controller;
    fetch(`/api/suggest?q=${encodeURIComponent(q)}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) return void dispatchCombo({ type: "fetchError", generation });
        const data = (await res.json()) as { suggestions?: unknown };
        // A valid-but-wrong-shape body (no array) is an error, not "no matches" —
        // and must not reach the render, which reads `.length`.
        if (!Array.isArray(data.suggestions)) return void dispatchCombo({ type: "fetchError", generation });
        dispatchCombo({ type: "suggestionsLoaded", generation, suggestions: data.suggestions as Suggestion[] });
      })
      .catch((err) => {
        // A superseded/blurred request is aborted — leave its state to the newer
        // run. A genuine network/parse failure surfaces the error state so the
        // dropdown does not sit forever on "Searching…" (the reducer drops it if
        // the generation is already stale).
        if ((err as Error)?.name === "AbortError") return;
        dispatchCombo({ type: "fetchError", generation });
      });
  }

  function scheduleSuggest(state: ComboboxState) {
    if (suggestTimerRef.current) clearTimeout(suggestTimerRef.current);
    if (!shouldFetchSuggest(state)) return;
    const generation = state.generation;
    const q = state.query.trim();
    suggestTimerRef.current = setTimeout(() => runSuggest(generation, q), SUGGEST_DEBOUNCE_MS);
  }

  function onQueryChange(value: string) {
    suggestAbortRef.current?.abort(); // cancel any in-flight fetch synchronously
    scheduleSuggest(dispatchCombo({ type: "queryChanged", value }));
  }

  function closeSuggest() {
    if (suggestTimerRef.current) clearTimeout(suggestTimerRef.current);
    suggestAbortRef.current?.abort();
    dispatchCombo({ type: "close" });
  }

  function pickSuggestion(s: Suggestion) {
    if (suggestTimerRef.current) clearTimeout(suggestTimerRef.current);
    suggestAbortRef.current?.abort();
    dispatchCombo({ type: "pick", suggestion: s });
    selectRef.current?.({ kind: "point", lat: s.lat, lng: s.lng, label: s.label });
  }

  function switchMode(next: Mode) {
    if (next === selRef.current.mode) return;
    // Invalidate any in-flight select so a walk response can't land under a
    // transit toggle (or vice-versa); the reducer bumps the token to match.
    abortRef.current?.abort();
    dispatchSel({ type: "toggle", next });
    // Recompute the current point in the new mode — no geocode/reverse. With no
    // resolved selection the reducer already reset status to idle.
    const last = selRef.current.lastSelection;
    if (last)
      selectRef.current?.({ kind: "point", lat: last.lat, lng: last.lng, label: last.label }, { recompute: true });
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const combo = comboRef.current;
    const active = combo.open && combo.activeIndex >= 0 ? combo.suggestions[combo.activeIndex] : undefined;
    if (active) return pickSuggestion(active);
    const q = combo.query.trim();
    if (q) {
      closeSuggest();
      selectRef.current?.({ kind: "search", query: q });
    }
  }

  function onSearchKeyDown(e: React.KeyboardEvent) {
    const combo = comboRef.current;
    if (!combo.open || combo.suggestions.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      dispatchCombo({ type: "arrowDown" });
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      dispatchCombo({ type: "arrowUp" });
    } else if (e.key === "Escape") {
      closeSuggest();
    }
    // Enter is handled by the form's onSubmit (which picks the active option).
  }

  const sel = selState;
  const combo = comboState;

  return (
    <div className="absolute inset-0">
      <div ref={containerRef} data-testid="app-map" className="h-full w-full" />

      {/* Search + status overlay. pointer-events-none wrapper; interactive bits opt back in. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex flex-col items-center gap-2 px-4 pt-20 sm:pt-24">
        <form onSubmit={onSubmit} className="pointer-events-auto flex w-full max-w-md gap-2">
          <input
            value={combo.query}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={onSearchKeyDown}
            onBlur={closeSuggest}
            onFocus={() => dispatchCombo({ type: "focus" })}
            placeholder="Search a Bucharest address — or click the map"
            aria-label="Search a Bucharest address"
            role="combobox"
            aria-expanded={combo.open}
            aria-controls="suggest-list"
            aria-activedescendant={combo.activeIndex >= 0 ? `suggest-opt-${combo.activeIndex}` : undefined}
            autoComplete="off"
            className="w-full rounded-full border border-white/15 bg-black/50 px-4 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-500 backdrop-blur focus:border-teal-300/60 focus:outline-none"
          />
          <button
            type="submit"
            disabled={sel.status === "loading"}
            className="rounded-full bg-teal-400/90 px-4 py-2.5 text-sm font-medium text-zinc-950 transition-colors hover:bg-teal-300 disabled:opacity-50"
          >
            {sel.status === "loading" ? "…" : "Go"}
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
              aria-pressed={sel.mode === m}
              className={`rounded-full px-5 py-1.5 text-sm font-medium transition-colors ${
                sel.mode === m
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

        {combo.open && combo.query.trim().length >= MIN_SUGGEST_LEN && (
          <ul
            id="suggest-list"
            role="listbox"
            className="pointer-events-auto w-full max-w-md overflow-hidden rounded-2xl border border-white/10 bg-black/70 backdrop-blur"
          >
            {combo.status === "loading" ? (
              <li className="px-4 py-2.5 text-sm text-zinc-500">Searching…</li>
            ) : combo.status === "error" ? (
              <li className="px-4 py-2.5 text-sm text-amber-300">Couldn’t load suggestions. Try again.</li>
            ) : combo.suggestions.length === 0 ? (
              <li className="px-4 py-2.5 text-sm text-zinc-500">No matches in Bucharest</li>
            ) : (
              combo.suggestions.map((s, i) => (
                <li
                  key={`${s.lat},${s.lng},${i}`}
                  id={`suggest-opt-${i}`}
                  role="option"
                  aria-selected={i === combo.activeIndex}
                  onPointerDown={(e) => {
                    e.preventDefault(); // keep focus so the pick runs before blur (mouse + touch)
                    pickSuggestion(s);
                  }}
                  onMouseEnter={() => dispatchCombo({ type: "hover", index: i })}
                  className={`cursor-pointer px-4 py-2.5 text-sm ${
                    i === combo.activeIndex ? "bg-teal-400/20 text-zinc-50" : "text-zinc-200"
                  }`}
                >
                  {s.label}
                </li>
              ))
            )}
          </ul>
        )}

        {(sel.label || sel.message) && (
          <div className="pointer-events-auto flex max-w-md flex-col items-center gap-1 rounded-2xl border border-white/10 bg-black/50 px-4 py-2 text-center backdrop-blur">
            {sel.message ? (
              <p className="text-sm text-amber-300">{sel.message}</p>
            ) : (
              <>
                <p className="line-clamp-2 text-sm text-zinc-200">{sel.label}</p>
                <div className="flex items-center gap-3 text-xs text-zinc-400">
                  <span className="font-medium text-zinc-300">{MODE_LABEL[sel.mode]}</span>
                  {LEGEND_MINUTES.map((m) => (
                    <span key={m} className="flex items-center gap-1.5">
                      <span
                        className="inline-block h-2 w-2 rounded-full"
                        style={{ background: legendColor(sel.mode, m) }}
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
