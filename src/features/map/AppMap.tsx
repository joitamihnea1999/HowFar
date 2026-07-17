"use client";

import maplibregl from "maplibre-gl";
import { Protocol } from "pmtiles";
import { useEffect, useRef, useState } from "react";

import "maplibre-gl/dist/maplibre-gl.css";

import {
  buildAmenityFeatures,
  countByCategory,
  type Amenity,
  type AmenityCounts,
} from "@/features/amenities/amenities";
import { isNewAmenityOrigin, originKey } from "@/features/amenities/amenities-flow";
import { BUCHAREST_MAX_BOUNDS } from "@/lib/bounds";
import { buildIsochroneFeatures, MARKER_COLOR } from "@/features/isochrones/isochrone-view";
import AmenityPanel from "@/features/map/AmenityPanel";
import AttributionBadge from "@/features/map/AttributionBadge";
import {
  addAmenityLayers,
  addIsochroneLayers,
  createMapStyle,
  EMPTY_FC,
} from "@/features/map/map-setup";
import ModeToggle from "@/features/map/ModeToggle";
import SearchForm from "@/features/map/SearchForm";
import SelectionCard from "@/features/map/SelectionCard";
import SuggestList from "@/features/map/SuggestList";
import {
  comboboxReducer,
  initialComboboxState,
  shouldFetchSuggest,
  type ComboboxAction,
  type ComboboxState,
  type Suggestion,
} from "@/features/search/combobox";
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
} from "@/features/map/selection-flow";

// Piața Unirii — the classic Bucharest reference point.
const BUCHAREST_CENTER: [number, number] = [26.1025, 44.4268];
const SUGGEST_DEBOUNCE_MS = 250;

interface GeoPoint {
  lat: number;
  lng: number;
  label: string;
}

/** Amenities are a property of the resolved address, independent of the travel
 * mode — so they live outside the selection state machine, in their own UI slice. */
type AmenityUi = { status: "idle" | "loading" | "ready" | "error"; counts: AmenityCounts | null };

export default function AppMap() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const selectRef = useRef<((input: SelectInput, opts?: { recompute?: boolean }) => void) | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const suggestAbortRef = useRef<AbortController | null>(null);
  const suggestTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Amenities: keyed by rounded origin (NOT the selection token, which a mode
  // toggle bumps) so a Walk↔Transit toggle persists the markers with no refetch;
  // a generation guards stale responses.
  const amenityAbortRef = useRef<AbortController | null>(null);
  const amenityGenRef = useRef(0);
  const amenityKeyRef = useRef<string | null>(null);
  const clearAmenitiesRef = useRef<(() => void) | null>(null);
  const [amenity, setAmenity] = useState<AmenityUi>({ status: "idle", counts: null });

  // The two extracted state machines drive the render via useState, but each is
  // mirrored in a ref so a dispatch can be read back synchronously in the same
  // tick (fresh token/generation) from the imperative fetch orchestration —
  // see features/map/selection-flow and features/search/combobox. Render reads the state; callbacks
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
      style: createMapStyle(`${window.location.origin}/api/tiles`),
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
    let pendingAmenities: { items: Amenity[]; counts: AmenityCounts } | null = null;

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

    // `counts` are the server's TRUE clipped totals (may exceed the rendered
    // marker count when a category was capped) — the chips show these, not a
    // recount of the capped markers.
    function renderAmenities(items: Amenity[], counts: AmenityCounts) {
      // Buffer until the style (and the amenities source) exist — an amenity
      // response can land before `load`, exactly like the isochrone.
      if (!styleLoaded) {
        pendingAmenities = { items, counts };
        setAmenity({ status: "ready", counts });
        return;
      }
      (map.getSource("amenities") as maplibregl.GeoJSONSource | undefined)?.setData({
        type: "FeatureCollection",
        features: buildAmenityFeatures(items) as GeoJSON.Feature[],
      });
      el.dataset.amenityCount = String(items.length);
      setAmenity({ status: "ready", counts });
    }

    // Drop amenity markers/counts and supersede any in-flight fetch. Called only
    // on a genuinely-new selection — NOT on a mode toggle (which must persist).
    function clearAmenities() {
      amenityAbortRef.current?.abort();
      amenityGenRef.current += 1;
      amenityKeyRef.current = null;
      pendingAmenities = null;
      (map.getSource("amenities") as maplibregl.GeoJSONSource | undefined)?.setData(
        EMPTY_FC as GeoJSON.FeatureCollection,
      );
      delete el.dataset.amenityCount;
      setAmenity({ status: "idle", counts: null });
    }
    clearAmenitiesRef.current = clearAmenities;

    // Fetch amenities for a resolved origin, in parallel with the isochrone. A
    // toggle recompute resolves the same origin ⇒ no refetch. A failure surfaces
    // an amenity-only error and never touches the isochrone.
    function maybeFetchAmenities(origin: Origin) {
      const key = originKey(origin.lat, origin.lng);
      if (!isNewAmenityOrigin(amenityKeyRef.current, key)) return;
      amenityKeyRef.current = key;
      const gen = (amenityGenRef.current += 1);
      amenityAbortRef.current?.abort();
      const controller = new AbortController();
      amenityAbortRef.current = controller;
      setAmenity({ status: "loading", counts: null });
      fetch(`/api/amenities?lat=${origin.lat}&lng=${origin.lng}`, { signal: controller.signal })
        .then(async (res) => {
          if (gen !== amenityGenRef.current) return;
          if (!res.ok) return void setAmenity({ status: "error", counts: null });
          const data = (await res.json()) as { amenities?: unknown; counts?: AmenityCounts };
          if (gen !== amenityGenRef.current) return;
          // A valid-but-wrong-shape body (no array) is an error, not "no amenities".
          if (!Array.isArray(data.amenities)) return void setAmenity({ status: "error", counts: null });
          const items = data.amenities as Amenity[];
          renderAmenities(items, data.counts ?? countByCategory(items));
        })
        .catch((err) => {
          if ((err as Error)?.name === "AbortError" || gen !== amenityGenRef.current) return;
          setAmenity({ status: "error", counts: null });
        });
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
      // A genuinely-new selection also drops the old amenities; a mode toggle
      // (recompute) leaves them so they persist across Walk↔Transit.
      if (!opts?.recompute) clearAmenities();

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

        // Fire amenities in parallel with the isochrone (both use `origin`); its
        // own generation/abort make it independent of this selection's token.
        maybeFetchAmenities(origin);

        const isoRes = await fetch(`${isochronePath(mode)}?lat=${origin.lat}&lng=${origin.lng}`, { signal });
        if (stale()) return;
        if (!isoRes.ok) {
          // A fresh selection whose reach failed must not leave orphan amenity
          // markers (no rings to anchor them). A failed recompute deliberately
          // keeps the amenities — but clearSelection() above already dropped the
          // prior rings, so they sit orphaned until the next selection/toggle
          // (known latent gap; the failure message is shown meanwhile).
          if (!opts?.recompute) clearAmenities();
          return void dispatchSel({ type: "failed", token, stage: "isochrone", httpStatus: isoRes.status });
        }
        const iso = (await isoRes.json()) as { origin: Origin; rings: Ring[] };
        if (stale()) return;

        // Fresh (stale() just checked): accept and paint. Reducer records the
        // isochrone's rounded origin so a mode toggle recomputes the same point.
        dispatchSel({ type: "resolved", token, origin: iso.origin, label });
        renderSelection(iso.origin, label, iso.rings, mode);
      } catch (err) {
        if ((err as Error)?.name === "AbortError" || stale()) return;
        if (!opts?.recompute) clearAmenities();
        dispatchSel({ type: "crash", token });
      }
    }

    selectRef.current = select;

    map.on("load", () => {
      // Source + layer specs live in map-setup (unit-tested); amenity markers
      // draw on top of the isochrone fills by add order.
      addIsochroneLayers(map);
      addAmenityLayers(map);

      styleLoaded = true;
      if (pending) {
        const p = pending;
        pending = null;
        renderSelection(p.origin, p.label, p.rings, p.mode);
      }
      if (pendingAmenities) {
        const a = pendingAmenities;
        pendingAmenities = null;
        renderAmenities(a.items, a.counts);
      }
      el.dataset.mapLoaded = "true";
    });

    map.on("click", (e) => selectRef.current?.({ kind: "click", lat: e.lngLat.lat, lng: e.lngLat.lng }));

    return () => {
      abortRef.current?.abort();
      suggestAbortRef.current?.abort();
      amenityAbortRef.current?.abort();
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
    if (last) {
      selectRef.current?.({ kind: "point", lat: last.lat, lng: last.lng, label: last.label }, { recompute: true });
    } else {
      // Toggling away from a still-loading first selection cancels it — drop its
      // in-flight amenities too, so a late response can't paint orphan markers.
      clearAmenitiesRef.current?.();
    }
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
  const amenityCounts = amenity.counts;

  return (
    <div className="absolute inset-0">
      <div ref={containerRef} data-testid="app-map" className="h-full w-full" />

      {/* Search + status overlay. pointer-events-none wrapper; interactive bits opt back in. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex flex-col items-center gap-2 px-4 pt-20 sm:pt-24">
        <SearchForm
          query={combo.query}
          open={combo.open}
          activeIndex={combo.activeIndex}
          loading={sel.status === "loading"}
          onSubmit={onSubmit}
          onQueryChange={onQueryChange}
          onKeyDown={onSearchKeyDown}
          onFocus={() => dispatchCombo({ type: "focus" })}
          onBlur={closeSuggest}
        />
        <ModeToggle mode={sel.mode} onSwitch={switchMode} />
        <SuggestList
          combo={combo}
          onPick={pickSuggestion}
          onHover={(index) => dispatchCombo({ type: "hover", index })}
        />
        <SelectionCard label={sel.label} message={sel.message} mode={sel.mode} />
        <AmenityPanel status={amenity.status} counts={amenityCounts} />
      </div>

      <AttributionBadge />
    </div>
  );
}
