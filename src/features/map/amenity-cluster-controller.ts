import type maplibregl from "maplibre-gl";
import { mapGl } from "@/features/map/map-runtime";

import { amenityCategoryLabel, type AmenityCategoryKey } from "@/features/amenities/amenities";
import {
  agglomerateClusters,
  AMENITY_SOURCE_MAX_ZOOM,
  clusterCategoryCounts,
  clusterFootprintRadius,
  DONUT_HOVER_SCALE,
  clusterMarkerSizePx,
  resolveGenerations,
  pinFootprintRadius,
  type TileRef,
  clusterRadiusForCount,
  CLUSTER_RING_THICKNESS_PX,
  donutArcs,
  totalFromCounts,
  type ClusterCandidate,
} from "@/features/amenities/amenity-cluster";
import type { LoadState } from "@/features/map/load-state";

/**
 * Category-donut cluster markers (task 061).
 *
 * When amenities are too dense to draw individually, the clustered source hands
 * us aggregates — and the aggregate still has to answer the owner's actual
 * question, "what kinds of places are here?". A plain numbered bubble throws that
 * away, so each cluster renders as a ring split into per-category arcs with the
 * member total in the centre: at a glance, "14 places, mostly groceries, one
 * pharmacy, a transit stop".
 *
 * MapLibre layers cannot paint arcs, so these are DOM `Marker`s carrying inline
 * SVG. Two consequences shape this module:
 *
 * - **They are outside the layer/filter system**, so visibility is an explicit
 *   call (`setVisible`) driven from the amenities controller's single chokepoint.
 *   A `setFilter` that correctly hid every WebGL layer would leave donuts painted
 *   over a drawn journey.
 * - **They need their own reconcile loop.** `querySourceFeatures` returns
 *   per-tile duplicates, and during a zoom animation it briefly reports a mix of
 *   old- and new-zoom clusters, so reconciling only on `moveend` strands ghost
 *   donuts at stale positions while the WebGL pins have already moved. Reconcile
 *   runs rAF-coalesced on `render`/`sourcedata`, deduplicated by `cluster_id`.
 *
 * Each donut is a real `<button>`: keyboard-reachable, and its `aria-label` names
 * the breakdown so the aggregate is not a mouse-only, sighted-only affordance.
 */

/** Marker DOM class — also the e2e handle for counting rendered donuts. */
export const CLUSTER_MARKER_CLASS = "hf-amenity-cluster";

/** Minimum tap radius for a donut, independent of its drawn size — half of the 44px
 * target the rest of the UI honours. The donut stays visually compact (widening the
 * ring would breach the size envelope); only its hit area grows. */
export const MIN_MARK_TAP_RADIUS_PX = 22;

/**
 * Hit radius for a mark drawn at `radius`, by pointer kind.
 *
 * A mouse gets EXACTLY the drawn mark: you click what you see. Any margin at all
 * blankets the map, because two donuts may render tangent — with even a 4px pad their
 * targets then overlap and no point between them is free, so clicking bare map to pick a
 * new address becomes impossible in a dense field (found in review). Touch keeps the 44px
 * target, which is what that requirement is actually about.
 */
export function hitRadius(radius: number, coarse: boolean): number {
  return coarse ? Math.max(radius, MIN_MARK_TAP_RADIUS_PX) : radius;
}

/** A snapshot of one absorbed pin, taken when the mark was built.
 *
 * Shaped like `cluster-expand`'s `LeafFeature` so the popup can list it with no
 * conversion — and deliberately a COPY rather than a live feature reference: the
 * whole point is that resolving an absorbed pin never needs a second source query. */
export interface AbsorbedPin {
  id: number;
  properties: Record<string, unknown> | null;
  geometry: { type: "Point"; coordinates: [number, number] };
}

/** A donut resolved from a screen-space pick. */
export interface ClusterPick {
  /** Stable entry key (merged id set) — the handle the hover path grows/reverts
   * by, so a rebuilt element re-acquires its hover state inside reconcile
   * (task 062). */
  key: string;
  /** Per-category breakdown carried on the mark since reconcile time — the
   * hover preview renders from THIS, synchronously; it never re-queries the
   * source (task 062 contract, found in review). */
  counts: { category: AmenityCategoryKey; count: number }[];
  ids: number[];
  /** Absorbed unclustered-pin feature ids (the absorbed-pin case). MUST be carried through the pointer
   * path: an absorbed pin is hidden from the pin layer, so dropping it here makes the
   * place unreachable by mouse — the exact defect this task removes. */
  pinIds: number[];
  /** The absorbed pins' own data, captured at reconcile time (found in review).
   * Resolving them by re-querying the source at click time could MISS an id (viewport
   * edge, mid-recluster, source race) and turn the mark into a dead click. */
  pins: AbsorbedPin[];
  coords: [number, number];
  total: number;
  /** Pointer distance to the mark's centre, so the caller can arbitrate against a pin
   * hit. The widened tap radius means a donut can claim a point that lies visibly
   * INSIDE a nearby pin's disc — the no-overlap guarantee only makes footprints
   * non-intersecting, so their targets can (found in review). */
  distance: number;
}

export interface AmenityClusterController {
  setVisible: (visible: boolean) => void;
  /** The donut under a screen point, if any (nearest centre wins).
   *
   * `coarse` selects the touch target. The 44px target exists for FINGERS; applying it to
   * a mouse blanketed the map — the smallest two donuts sit ~26px apart, so with a 22px
   * pad no point between them was free, and clicking bare map to pick a new address
   * became impossible across a dense donut field (found in review). A mouse therefore
   * gets the drawn ring plus a small margin; touch keeps the full target. */
  pickAt: (point: { x: number; y: number }, coarse?: boolean) => ClusterPick | null;
  /** Hover a screen point (task 062): grows the mark under it (inner-SVG scale
   * — MapLibre rewrites the marker root's transform every frame, so the root
   * must stay untouched), reverts the previous one, and returns the pick so the
   * caller can render the preview panel from its `counts` — synchronously, no
   * source query. Pass `null` on mouseout/movestart to revert. The caller owns
   * the pointer-capability gate (touch browsers synthesize mousemove).
   * Stale-gated like `pickAt`: mid-recluster the marks answer no hover. */
  hoverAt: (point: { x: number; y: number } | null) => ClusterPick | null;
  clear: () => void;
  refresh: () => void;
  /** Is a rendered mark under this point, regardless of staleness?
   *
   * `pickAt` deliberately returns null while the marks are stale, but the donuts stay
   * VISIBLE — so the map's click handler saw "no mark here" and fell through to a full
   * address re-selection at that coordinate, breaking the rule that inspecting a marker
   * never recomputes the address (found in review). The handler uses this to swallow the
   * click instead. */
  covers: (point: { x: number; y: number }, coarse?: boolean) => boolean;
  /** Rendered donut count — backs the `data-amenity-clusters` stamp. */
  count: () => number;
  /** Feature ids of unclustered pins absorbed into a donut (the absorbed-pin case). The amenities
   * controller's filter chokepoint hides these so no place is drawn twice. */
  absorbedPinIds: () => number[];
  /** Drop the absorbed set immediately. Called BEFORE a recluster applies its layer
   * filter: the old set refers to feature ids from the previous indexing, so leaving
   * it in place would hide a pin that is no longer absorbed for the frame between
   * `setData` and the next reconcile (found in review). */
  clearAbsorbed: () => void;
  /** Suspend hit-testing until the next successful reconcile (found in review).
   * `setData` re-indexes cluster ids ASYNCHRONOUSLY — the worker reclusters and
   * `sourcedata` schedules a reconcile a frame or more later — so between the two,
   * every donut on screen still carries cluster ids that now mean something else.
   * A click in that window would open a list of the wrong places (or of a category
   * the user just hid). Marks stay VISIBLE (blanking them would flicker on every
   * toggle); they simply stop answering clicks until they are known-good again. */
  invalidateMarks: () => void;
  dispose: () => void;
}

interface Entry {
  /** The entries-map key, stored on the entry so hover state can survive the
   * remove-and-recreate rebuild path inside reconcile (task 062). */
  key: string;
  marker: maplibregl.Marker;
  el: HTMLButtonElement;
  signature: string;
  lng: number;
  lat: number;
  ids: number[];
  /** Absorbed unclustered-pin feature ids represented by this mark (the absorbed-pin case). */
  pinIds: number[];
  /** Those pins' own data, so the mark can produce them with no source re-query. */
  pins: AbsorbedPin[];
  total: number;
  radius: number;
  /** Per-category breakdown, snapshotted at reconcile time for the hover preview. */
  counts: { category: AmenityCategoryKey; count: number }[];
}

/**
 * The tile zoom a source feature was read from, or null if it cannot be known.
 *
 * MapLibre stamps the canonical tile `z`/`x`/`y` on every feature that
 * `querySourceFeatures` returns — it needs them to project the tile-local geometry
 * back to lng/lat — but only under underscore-prefixed names, so this is read
 * defensively. When it is missing, `pickClusterGeneration` keeps every candidate,
 * i.e. a MapLibre change degrades this to the previous behaviour rather than
 * breaking the display.
 *
 * Deliberately NOT decoded from `cluster_id`: supercluster does encode the zoom
 * there, but offset by the source's point count, which the client has no reliable
 * way to know.
 */
function tileOf(feature: maplibregl.GeoJSONFeature): TileRef | null {
  const f = feature as unknown as { _z?: unknown; _x?: unknown; _y?: unknown };
  const [z, x, y] = [f._z, f._x, f._y];
  if (typeof z !== "number" || typeof x !== "number" || typeof y !== "number") return null;
  if (!Number.isFinite(z) || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { z, x, y };
}

/**
 * Build one category-donut element.
 *
 * Exported because the spiderfy fan (task 061 W20) draws the SAME donut as its
 * hub: a fan is an expansion of a mark, so the mark must not change appearance
 * when it expands, or the user loses track of which aggregate they opened. The
 * caller owns the click behaviour and may override the `aria-label` (the hub
 * collapses rather than lists).
 */
export function buildDonutElement(
  counts: { category: AmenityCategoryKey; count: number }[],
  total: number,
): HTMLButtonElement {
  const radius = clusterRadiusForCount(total);
  // One shared size formula with the overlap-resolution pass (clusterMarkerSizePx),
  // so the box agglomeration reasons about is exactly the box that renders.
  const size = clusterMarkerSizePx(total);
  const button = document.createElement("button");
  button.type = "button";
  button.className = CLUSTER_MARKER_CLASS;
  button.style.cssText = `width:${size}px;height:${size}px;padding:0;border:0;background:none;cursor:pointer;display:block;line-height:0`;

  const breakdown = counts.map((c) => `${c.count} ${amenityCategoryLabel(c.category).toLowerCase()}`).join(", ");
  // Action-NEUTRAL wording (reviewers): the ladder decides at
  // click time whether this mark zooms, fans out, or lists, so promising "list them"
  // described the wrong action for the very common splittable case.
  button.setAttribute(
    "aria-label",
    `${total} ${total === 1 ? "place" : "places"} here: ${breakdown}. Activate to open them.`,
  );
  button.dataset.clusterTotal = String(total);

  const svgNs = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNs, "svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", `${-size / 2} ${-size / 2} ${size} ${size}`);
  svg.setAttribute("aria-hidden", "true");

  // Dark seat so the ring reads against both the basemap and the isochrone fills.
  const seat = document.createElementNS(svgNs, "circle");
  seat.setAttribute("r", String(Math.max(1, radius - CLUSTER_RING_THICKNESS_PX / 2)));
  seat.setAttribute("fill", "#0b1210");
  seat.setAttribute("fill-opacity", "0.92");
  svg.appendChild(seat);

  for (const arc of donutArcs(counts, radius)) {
    const path = document.createElementNS(svgNs, "path");
    path.setAttribute("d", arc.d);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", arc.color);
    path.setAttribute("stroke-width", String(CLUSTER_RING_THICKNESS_PX));
    path.setAttribute("stroke-linecap", "butt");
    svg.appendChild(path);
  }

  const label = document.createElementNS(svgNs, "text");
  label.setAttribute("text-anchor", "middle");
  label.setAttribute("dominant-baseline", "central");
  label.setAttribute("fill", "#f4f7f2");
  // 12px (11 for 3-digit counts) — the 10px digits were the owner's "number
  // inside them bigger" complaint (task 062); the ring grew to 40px so the
  // larger label still clears the arc band.
  label.setAttribute("font-size", total >= 100 ? "11" : "12");
  label.setAttribute("font-weight", "600");
  // textContent, never innerHTML — the count is derived data, but this element is
  // built the same XSS-safe way as the stop popup.
  label.textContent = String(total);
  svg.appendChild(label);

  button.appendChild(svg);
  return button;
}

export function createAmenityClusterController({
  map,
  el,
  loadState,
  onClusterClick,
  onAbsorbedChange,
  onHoverLost,
}: {
  map: maplibregl.Map;
  el: HTMLElement;
  loadState: LoadState;
  /** Opens the "N places here" list for a cluster. */
  /** Opens the "N places here" list. Receives EVERY supercluster id the mark
   * represents, since screen-space agglomeration can merge several. */
  onClusterClick: (
    clusterIds: number[],
    coords: [number, number],
    total: number,
    pinIds: number[],
    pins: AbsorbedPin[],
    /** True when activated from the keyboard (Enter/Space on the button). The fan is
     * pointer-only — it has no focusable leaves — so the ladder routes keyboard
     * activations to the list instead (found in review). */
    keyboard: boolean,
  ) => void;
  /** Called when the absorbed-pin set changes, so the amenities controller can
   * re-apply its layer filter and stop drawing an absorbed pin twice (the absorbed-pin case). */
  onAbsorbedChange: () => void;
  /** Called when a hover is dropped by the CONTROLLER rather than the pointer —
   * the hovered mark disappeared in a reconcile, a recluster invalidated the
   * marks, or the layer cleared — so the caller can close its preview panel
   * (task 062). Not called for ordinary `hoverAt` transitions. */
  onHoverLost?: () => void;
}): AmenityClusterController {
  // Keyed by the merged supercluster id set (see reconcile), not a single id.
  const entries = new Map<string, Entry>();
  let visible = true;
  let raf = 0;
  let disposed = false;
  // The hovered mark's entry key (task 062). Owned HERE because reconcile
  // rebuilds donut elements — an externally-applied transform dies on the next
  // camera frame; the controller re-applies it to the rebuilt element instead.
  let hoveredKey: string | null = null;
  function applyHoverVisual(entry: Entry, on: boolean) {
    // Scale the inner SVG, never the marker root: MapLibre owns the root's
    // transform and rewrites it on every camera frame.
    const svg = entry.el.firstElementChild as SVGElement | null;
    if (svg) {
      svg.style.transition = "transform 120ms ease";
      svg.style.transformOrigin = "center";
      svg.style.transform = on ? `scale(${DONUT_HOVER_SCALE})` : "";
    }
    // z-lift on the root (MapLibre rewrites transform, not z-index) so the
    // grown mark rises above tangent neighbours.
    entry.el.style.zIndex = on ? "2" : "";
  }
  function setHoveredEntry(key: string | null) {
    if (key === hoveredKey) return;
    if (hoveredKey !== null) {
      const prev = entries.get(hoveredKey);
      if (prev) applyHoverVisual(prev, false);
    }
    hoveredKey = key;
    if (key !== null) {
      const next = entries.get(key);
      if (next) applyHoverVisual(next, true);
      el.dataset.amenityClusterHover = key;
    } else {
      delete el.dataset.amenityClusterHover;
    }
  }
  /** Controller-initiated hover drop (mark gone / marks stale / cleared). */
  function dropHover() {
    if (hoveredKey === null) return;
    setHoveredEntry(null);
    onHoverLost?.();
  }
  /** Hit radius honours the hover growth: the enlarged outer ring must resolve
   * to the mark, not click through to a bare-map re-selection (found in review). */
  const effectiveRadius = (entry: Entry) =>
    entry.key === hoveredKey ? entry.radius * DONUT_HOVER_SCALE : entry.radius;
  /** One pick shape for pickAt and hoverAt — copies, never live references. */
  const pickOf = (entry: Entry, distance: number): ClusterPick => ({
    key: entry.key,
    counts: entry.counts.map((c) => ({ ...c })),
    ids: [...entry.ids],
    pinIds: [...entry.pinIds],
    pins: [...entry.pins],
    coords: [entry.lng, entry.lat],
    total: entry.total,
    distance,
  });
  // Cheap change-detection so a steady-state animation frame costs nothing.
  // Reconciling on every `render` is necessary for correctness during a zoom (see
  // the note above), but doing the full querySourceFeatures + agglomeration + DOM
  // diff on frames where NOTHING moved is pure waste — and measurably slows the
  // parallel e2e run. `dataEpoch` is bumped by `sourcedata`, so a recluster still
  // forces a pass even when the camera is still.
  let lastSignature = "";
  let dataEpoch = 0;
  let absorbed: number[] = [];
  // Hit-testing is suspended between a `setData` and the reconcile that follows it:
  // the ids the rendered marks carry are stale the instant the source re-indexes.
  let marksStale = false;
  /** `dataEpoch` at the moment staleness was declared. Clearing the flag requires the
   * epoch to have ADVANCED past it — i.e. an amenities `sourcedata` has since arrived
   * — because the worker recluster takes ~35-41ms (measured, W2) while the recovery
   * frame runs in ~16ms. An earlier version got this wrong that the frame therefore
   * reconciled the OLD tiles, rebuilt the same marks with now-stale ids, and cleared
   * the guard: the exact wrong-list race the flag documents itself as closing. */
  let staleEpoch = -1;
  /** Collision footprint: a donut uses its marker box; a lone unclustered pin uses
   * the shared `pinFootprintRadius` — its rendered radius at the CURRENT zoom plus
   * its outline — so a pin's real size decides whether it collides.
   *
   * `hovered: true` reserves the WORST case. A hovered pin grows by
   * `PIN_HOVER_SCALE` with a thicker stroke, so reserving only the resting
   * footprint let a hover reintroduce an overlap the pass had cleared (review
   * an earlier pass). Reserving the grown size costs a little extra merging and makes the
   * guarantee hold in every pointer state. */
  const pinAwareFootprint = (total: number) =>
    total <= 1
      ? pinFootprintRadius(map.getZoom(), true)
      : // Donuts hover-grow too since task 062 — reserve THEIR worst case as
        // well, or a hover could regrow an overlap this pass cleared (the
        // exact defect class the pin reservation already prevents).
        clusterFootprintRadius(total) * DONUT_HOVER_SCALE;

  function removeEntry(key: string) {
    const entry = entries.get(key);
    if (!entry) return;
    entry.marker.remove();
    entries.delete(key);
  }

  function clear() {
    dropHover(); // before the entries go — the preview must not outlive them
    for (const id of [...entries.keys()]) removeEntry(id);
    el.dataset.amenityClusters = "0";
    // Marks are gone, but staleness is about the SOURCE, not about them: if the data has
    // not settled yet (`dataEpoch <= staleEpoch`), the guard must survive — otherwise a
    // declutter/restore in the middle of a recluster (right-click journey opened and
    // closed) rebuilt donuts from old tiles with the guard off, which is exactly the
    // wrong-list race `invalidateMarks` exists to close (found in review). Once the
    // source has settled, the normal recovery check clears it.
    if (dataEpoch > staleEpoch) {
      marksStale = false;
      delete el.dataset.amenityClustersStale;
    }
    // Invalidate change-detection: without this, re-showing at the SAME camera
    // would be skipped as "nothing moved" and the donuts would never come back.
    lastSignature = "";
    if (absorbed.length > 0) {
      absorbed = [];
      onAbsorbedChange(); // an absorbed pin must become visible again
    }
  }

  function cameraSignature(): string {
    const c = map.getCenter();
    // Rounded to sub-pixel-irrelevant precision: enough to catch any real move,
    // coarse enough that floating-point jitter doesn't force a pass. Pitch and padding
    // are included because BOTH change the projection — omitting them let a
    // projection-changing move be mistaken for "nothing moved", skipping the
    // overlap-resolution pass entirely (found in review).
    const pad = map.getPadding();
    return [
      dataEpoch,
      map.getZoom().toFixed(4),
      `${c.lng.toFixed(6)},${c.lat.toFixed(6)}`,
      map.getBearing().toFixed(2),
      map.getPitch().toFixed(2),
      `${pad.top}/${pad.right}/${pad.bottom}/${pad.left}`,
    ].join("|");
  }

  function reconcile() {
    if (disposed) return;
    if (!visible) {
      // Decluttered: no donuts, and no reconcile work either.
      if (entries.size > 0) clear();
      return;
    }
    if (!loadState.styleLoaded || !map.getSource("amenities")) return;

    const signature = cameraSignature();
    // While the marks are stale the pass must run even at an unchanged camera, or the
    // recovery condition is never re-evaluated: a pass that found the source still
    // loading would set `lastSignature`, and the next frame would short-circuit before
    // reaching the check — leaving every donut permanently unclickable. (Caught by the
    // "source still loading" unit test, which is exactly the failure mode I flagged as
    // worse than the race when adding this guard.)
    if (signature === lastSignature && !marksStale) return; // nothing moved, no new data
    lastSignature = signature;

    const seenIds = new Set<number>();
    /** Absorbed-pin snapshots for THIS pass, keyed by feature id. */
    const pinData = new Map<number, AbsorbedPin>();
    let features: maplibregl.GeoJSONFeature[];
    try {
      features = map.querySourceFeatures("amenities", { filter: ["has", "point_count"] });
    } catch {
      // The source can be mid-teardown; a failed query is not fatal.
      return;
    }

    // Clusters are collected WITH the tile zoom they came from, then narrowed to a
    // single generation (found in review). Mid-zoom the source holds both the old and
    // the new tiling, and their clusters cover the same places under different ids —
    // merging across them would paint a donut with roughly double the true count.
    const collected: { tile: TileRef | null; candidate: ClusterCandidate }[] = [];
    for (const feature of features) {
      const props = feature.properties ?? {};
      const clusterId = Number(props.cluster_id);
      // Dedupe: querySourceFeatures returns a cluster once per tile it appears in.
      if (!Number.isFinite(clusterId) || seenIds.has(clusterId)) continue;
      if (feature.geometry.type !== "Point") continue;
      seenIds.add(clusterId);

      const counts = clusterCategoryCounts(props as Record<string, unknown>);
      // Prefer the true point_count; fall back to the accumulators so a cluster
      // still renders if a property is missing.
      const total = Number(props.point_count) || totalFromCounts(counts);
      if (total <= 0 || counts.length === 0) continue;

      const [lng, lat] = feature.geometry.coordinates as [number, number];
      const p = map.project([lng, lat]);
      collected.push({
        tile: tileOf(feature),
        candidate: { ids: [clusterId], pinIds: [], x: p.x, y: p.y, lng, lat, counts, total },
      });
    }
    // A GeoJSON source tiles at floor(zoom), clamped to its own maxzoom — that is the
    // generation the map is showing, so it is the one the donuts must agree with.
    const targetZ = Math.min(Math.floor(map.getZoom()), AMENITY_SOURCE_MAX_ZOOM);

    // Unclustered pins join the SAME collision pass (found in review). Supercluster
    // keeps a pin clear of a cluster's SEED, not of its centroid — and a centroid is a
    // weighted average that can drift toward that pin — so a donut and a lone pin could
    // overlap heavily while every donut-vs-donut pair was legal.
    let singles: maplibregl.GeoJSONFeature[] = [];
    try {
      singles = map.querySourceFeatures("amenities", { filter: ["!", ["has", "point_count"]] });
    } catch {
      singles = [];
    }
    // Pins are partitioned by tile generation for the SAME reason clusters are
    // (found in review): mid-zoom a POI can be a member of a new-generation
    // cluster while a retained old tile still reports it as an unclustered single, so
    // an unpartitioned pin would be absorbed into the donut that already counts it and
    // inflate the total by one — the "donut that lies" F3 exists to prevent. `seenPins`
    // cannot catch that: the two reports are one id in two different roles.
    const collectedPins: {
      tile: TileRef | null;
      id: number;
      category: AmenityCategoryKey;
      properties: Record<string, unknown> | null;
      coords: [number, number];
    }[] = [];
    for (const feature of singles) {
      const id = Number(feature.id);
      if (!Number.isFinite(id)) continue;
      if (feature.geometry.type !== "Point") continue;
      const category = feature.properties?.category as AmenityCategoryKey | undefined;
      if (!category) continue;
      collectedPins.push({
        tile: tileOf(feature),
        id,
        category,
        properties: feature.properties ? { ...feature.properties } : null,
        coords: feature.geometry.coordinates as [number, number],
      });
    }
    // Pins follow the clusters' generation. Only when there are no clusters to follow
    // (everything on screen is unclustered) do they pick their own — otherwise a stale
    // pin that is the sole member of the old generation would be "nearest to the
    // target among those present" and get absorbed into a donut that already counts it.
    // Same coverage rule as the clusters: an off-generation pin survives only where
    // nothing from the chosen generation is near enough to be the same place. Each pin is
    // projected ONCE here rather than inside the inner test.
    // ONE resolution over clusters AND pins: the same chosen generation binds both, and
    // an off-generation mark of either kind survives only where the chosen generation has
    // no tile coverage yet (so a partially-loaded zoom cannot blank a region).
    const resolved = resolveGenerations(
      [
        ...collected.map((c) => ({ tile: c.tile, kind: "cluster" as const, cluster: c })),
        ...collectedPins.map((p) => ({ tile: p.tile, kind: "pin" as const, pin: p })),
      ],
      targetZ,
    );
    const candidates: ClusterCandidate[] = resolved
      .filter((r) => r.kind === "cluster")
      .map((r) => (r as { cluster: { candidate: ClusterCandidate } }).cluster.candidate);
    const pinGeneration = resolved
      .filter((r) => r.kind === "pin")
      .map((r) => (r as { pin: (typeof collectedPins)[number] }).pin)
      .map((item) => {
        const p = map.project(item.coords);
        return { ...item, x: p.x, y: p.y };
      });
    const seenPins = new Set<number>();
    for (const { id, category, properties, coords, x: pinX, y: pinY } of pinGeneration) {
      if (seenPins.has(id)) continue;
      seenPins.add(id);
      const [plng, plat] = coords;
      // Snapshot the pin's own data NOW, so a mark that absorbs it can list it without
      // a second source query at click time (found in review).
      pinData.set(id, {
        id,
        properties,
        geometry: { type: "Point", coordinates: [plng, plat] },
      });
      candidates.push({
        ids: [],
        pinIds: [id],
        x: pinX,
        y: pinY,
        lng: plng,
        lat: plat,
        counts: [{ category, count: 1 }],
        total: 1,
      });
    }

    // Resolve donut-vs-donut collisions by merging. Supercluster bounds member
    // distance, NOT centroid distance, so two clusters can settle closer together
    // than the radius that formed them — an adversarial fixture found exactly that.
    // Sorted first so the greedy merge order does not depend on tile iteration
    // order (which varies with the camera). The final tie-break must be defined for
    // PIN candidates too — they carry no `ids`, so the original `a.ids[0]-b.ids[0]`
    // evaluated to NaN and left the ordering of exactly-coincident marks up to the
    // engine's sort implementation.
    const tieKey = (c: ClusterCandidate) => c.ids[0] ?? c.pinIds[0] ?? 0;
    candidates.sort((a, b) => a.x - b.x || a.y - b.y || tieKey(a) - tieKey(b));
    const groups = agglomerateClusters(candidates, pinAwareFootprint);

    // A pin that collided with nothing stays a WebGL pin — never draw a donut for it.
    const marks = groups.filter((g) => g.ids.length > 0 || g.pinIds.length > 1);
    const nextAbsorbed = marks.flatMap((g) => g.pinIds).sort((a, b) => a - b);
    if (nextAbsorbed.join(",") !== absorbed.join(",")) {
      absorbed = nextAbsorbed;
      onAbsorbedChange();
    }

    const liveKeys = new Set<string>();
    for (const group of marks) {
      // Key on the full merged id set, so a group that gains or loses a member is a
      // different mark and gets rebuilt rather than silently mislabelled.
      // Identity includes pinIds: a group that gains or loses an absorbed pin is a
      // DIFFERENT mark and must be rebuilt, or it would keep a stale click closure —
      // and two pin-only groups would otherwise collide on the same empty key.
      const key = `${[...group.ids].sort((a, b) => a - b).join("+")}#${[...group.pinIds].sort((a, b) => a - b).join("+")}`;
      liveKeys.add(key);
      const signature = `${group.total}|${group.counts.map((c) => `${c.category}:${c.count}`).join(",")}`;
      const existing = entries.get(key);
      if (existing && existing.signature === signature) {
        // Refresh the absorbed-pin snapshots even on a reused entry: the ids are the
        // same but the payload behind them was re-read this pass, and a reused entry
        // holding last pass's data is how a list goes subtly wrong.
        if (existing.pinIds.length > 0) {
          const refreshed = existing.pinIds
            .map((id) => pinData.get(id))
            .filter((p): p is AbsorbedPin => Boolean(p));
          if (refreshed.length === existing.pinIds.length) existing.pins = refreshed;
        }
        if (existing.lng !== group.lng || existing.lat !== group.lat) {
          existing.marker.setLngLat([group.lng, group.lat]);
          existing.lng = group.lng;
          existing.lat = group.lat;
        }
        continue;
      }
      if (existing) removeEntry(key);

      const button = buildDonutElement(group.counts, group.total);
      const ids = [...group.ids];
      const pinIds = [...group.pinIds];
      const pins = pinIds.map((id) => pinData.get(id)).filter((p): p is AbsorbedPin => Boolean(p));
      const anchor: [number, number] = [group.lng, group.lat];
      const total = group.total;
      button.addEventListener("click", (event) => {
        // The donut is a real button over the canvas: stop the event reaching the
        // map, or the click would also register as a bare-map selection.
        event.stopPropagation();
        event.preventDefault();
        // Same staleness gate as `pickAt` — this is the KEYBOARD path to the same
        // list, so guarding only the pointer path would leave the race open for
        // keyboard users alone.
        if (marksStale) return;
        // Activation supersedes any hover preview: the button path (keyboard
        // Enter/Space, or a synthetic click) stops propagation, so the map's
        // click handler never runs its own preview-close — drop the hover here
        // or the panel floats over the popup this activation opens
        // (found in review).
        dropHover();
        // Read the CURRENT entry rather than the closure's captured values
        // (found in review): a reused entry has its position and absorbed-pin
        // snapshots refreshed in place, so a listener created on the first pass would
        // otherwise activate with stale coordinates and stale pin data.
        const live = entries.get(key) ?? { ids, pinIds, pins, lng: anchor[0], lat: anchor[1], total };
        // `detail === 0` is how a button reports Enter/Space rather than a mouse click.
        const keyboard = (event as MouseEvent).detail === 0;
        onClusterClick(
          [...live.ids],
          [live.lng, live.lat],
          live.total,
          [...live.pinIds],
          [...live.pins],
          keyboard,
        );
      });
      const marker = new (mapGl().Marker)({ element: button }).setLngLat(anchor).addTo(map);
      const entry: Entry = {
        key,
        marker,
        el: button,
        signature,
        lng: anchor[0],
        lat: anchor[1],
        ids,
        pinIds,
        pins,
        total,
        radius: clusterFootprintRadius(total),
        counts: group.counts.map((c) => ({ ...c })),
      };
      entries.set(key, entry);
      // A rebuilt element loses its inline styles — re-acquire the hover state
      // the pointer still holds (task 062: reconcile runs every camera frame).
      if (key === hoveredKey) applyHoverVisual(entry, true);
    }

    // Drop donuts whose group no longer exists at this zoom/data.
    for (const key of [...entries.keys()]) if (!liveKeys.has(key)) removeEntry(key);
    // The hovered mark may have been dropped or merged away — tell the caller
    // so the preview panel never outlives its mark.
    if (hoveredKey !== null && !entries.has(hoveredKey)) dropHover();
    el.dataset.amenityClusters = String(entries.size);
    // Clicks mean what they say again ONLY if this pass actually saw the new data:
    // the epoch must have advanced past the invalidation AND the source must report
    // itself loaded. Otherwise the flag stays set and the next pass re-checks — the
    // `render`/`sourcedata` subscriptions guarantee there will be one.
    if (marksStale) {
      // Fail CLOSED on a readiness error, fail OPEN only when the API is absent
      // (found in review): a throwing call is a real "don't know", and
      // treating that as ready is how old ids become interactive again. A MapLibre
      // build without the method at all is a different thing — there the check simply
      // cannot participate, and stranding every donut inert would be worse. Feature
      // detection separates the two.
      let sourceReady: boolean;
      if (typeof map.isSourceLoaded !== "function") {
        sourceReady = true;
      } else {
        try {
          sourceReady = map.isSourceLoaded("amenities");
        } catch {
          sourceReady = false;
        }
      }
      if (dataEpoch > staleEpoch && sourceReady) {
        marksStale = false;
        delete el.dataset.amenityClustersStale;
      }
    }
  }

  function schedule() {
    if (disposed || raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      reconcile();
    });
  }

  // `render` covers zoom/pan animation frames (so donuts track the clustering
  // MapLibre is actually showing); `sourcedata` covers a setData/recluster.
  // Both are coalesced to one reconcile per frame.
  function onSourceData(e: maplibregl.MapSourceDataEvent) {
    if (e.sourceId && e.sourceId !== "amenities") return;
    dataEpoch += 1; // force the next pass even if the camera did not move
    schedule();
  }
  map.on("render", schedule);
  map.on("sourcedata", onSourceData);

  return {
    /**
     * Which donut is under this screen point?
     *
     * Donuts are `pointer-events: none` so they never swallow map gestures (a
     * long-press landing on one used to give no directions at all), which means the
     * map's own click handler has to resolve them. Nearest centre inside the
     * rendered footprint wins.
     */
    pickAt(point: { x: number; y: number }, coarse = false): ClusterPick | null {
      // Between a recluster and its reconcile the ids these marks carry are stale
      // (see `invalidateMarks`), so refuse the pick rather than open the wrong list.
      if (!visible || marksStale || entries.size === 0) return null;
      let best: { entry: Entry; d: number } | null = null;
      for (const entry of entries.values()) {
        const p = map.project([entry.lng, entry.lat]);
        const d = Math.hypot(p.x - point.x, p.y - point.y);
        // A donut is 26-34px wide and `pointer-events:none`, so its drawn radius alone
        // (13-17px) is well under the 44px touch target the rest of the UI honours
        // (found in review). The HIT radius is widened without changing the
        // drawn size; nearest-centre arbitration keeps it unambiguous, and the
        // no-overlap invariant guarantees marks are at least their footprints apart so
        // a widened donut target cannot swallow a neighbouring pin's centre.
        if (d > hitRadius(effectiveRadius(entry), coarse)) continue;
        if (!best || d < best.d) best = { entry, d };
      }
      return best ? pickOf(best.entry, best.d) : null;
    },
    hoverAt(point: { x: number; y: number } | null): ClusterPick | null {
      if (point === null) {
        setHoveredEntry(null);
        return null;
      }
      // Same stale gate as pickAt: mid-recluster the rendered arcs/counts may
      // describe the previous indexing, and a preview must never show them.
      if (!visible || marksStale || entries.size === 0) {
        dropHover();
        return null;
      }
      let best: { entry: Entry; d: number } | null = null;
      for (const entry of entries.values()) {
        const p = map.project([entry.lng, entry.lat]);
        const d = Math.hypot(p.x - point.x, p.y - point.y);
        if (d > hitRadius(effectiveRadius(entry), false)) continue;
        if (!best || d < best.d) best = { entry, d };
      }
      setHoveredEntry(best ? best.entry.key : null);
      return best ? pickOf(best.entry, best.d) : null;
    },
    covers(point: { x: number; y: number }, coarse = false) {
      if (!visible) return false;
      for (const entry of entries.values()) {
        const p = map.project([entry.lng, entry.lat]);
        if (Math.hypot(p.x - point.x, p.y - point.y) <= hitRadius(effectiveRadius(entry), coarse)) return true;
      }
      return false;
    },
    setVisible(next: boolean) {
      if (visible === next) return;
      visible = next;
      if (!next) clear();
      else schedule();
    },
    clear,
    refresh: schedule,
    count: () => entries.size,
    absorbedPinIds: () => absorbed,
    clearAbsorbed() {
      if (absorbed.length === 0) return;
      absorbed = [];
      lastSignature = ""; // force the next pass to recompute absorption
    },
    invalidateMarks() {
      // Stale marks answer no hover either — and the preview panel must close
      // rather than describe ids that now mean something else (task 062).
      dropHover();
      marksStale = true;
      staleEpoch = dataEpoch;
      // Read-back for the e2e, and an honest signal that these marks are inert.
      el.dataset.amenityClustersStale = "1";
      lastSignature = ""; // the next pass must run even if the camera never moved
      // Schedules its OWN recovery rather than trusting the caller to follow up: a
      // caller that invalidated and forgot to refresh would leave every donut
      // permanently unclickable, which is a worse failure than the race this closes.
      schedule();
    },
    dispose() {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      map.off("render", schedule);
      map.off("sourcedata", onSourceData);
      clear();
    },
  };
}
