import type maplibregl from "maplibre-gl";
import { mapGl } from "@/features/map/map-runtime";

import {
  AMENITY_CATEGORIES,
  amenityCategoryLabel,
  formatDistance,
  parseAmenityMembers,
  type Amenity,
  type AmenityCategoryKey,
  type TransitStopMember,
} from "@/features/amenities/amenities";
import { normalizeAmenitySelection } from "@/features/amenities/amenity-selection";
import { mergeStopLines, type StopLine } from "@/features/amenities/stop-lines";
import { buildStopPopupModel, STOP_POPUP_TEXT, type StopPopupModel } from "@/features/amenities/stop-popup";
import { leavesAreCoincident } from "@/features/amenities/amenity-spider";
import {
  collectClusterLeaves,
  decideMarkAction,
  leavesToAmenities,
  type IdentifiedLeaf,
  type LeafFeature,
} from "@/features/map/cluster-expand";
import type { EdgeInsets } from "@/features/map/route-framing";
import type { RoutePathController } from "@/features/map/route-path-controller";

/** Client-side deadline on the stop-lines fetch so a degraded Overpass can't
 * leave the popup on "Finding lines…" for the server's full host budget (task
 * 021 — the "never hang on loading" lesson). */
const STOP_LINES_TIMEOUT_MS = 9000;

/** Category → swatch colour for the cluster list rows. */
const AMENITY_COLOR_BY_KEY = Object.fromEntries(
  AMENITY_CATEGORIES.map((c) => [c.key, c.color]),
) as Record<AmenityCategoryKey, string>;

/**
 * The shared popup slot (task 021/024): one MapLibre popup at a time, routing a
 * picked amenity to either the transit stop-lines list or the generic POI info
 * card, plus the keyboard-accessible `inspectAmenity` companion to the WebGL
 * markers. DOM is built with `textContent` only (OSM names/headsigns are
 * untrusted — the XSS guard); the pure popup *model* is `buildStopPopupModel`.
 * A row carrying a relationId becomes a button that asks the route controller to
 * draw the line. `dispose` aborts the in-flight stop-lines fetch and removes the
 * popup. Reads route state only through its exposed getter, never private fields.
 *
 * The right-click "how do I get there?" DIRECTIONS moved out of here (task 058)
 * into `reach-directions-controller` + the result-sheet dock; this controller
 * keeps only the stop/POI popups. The two are mutually exclusive "active map
 * surfaces": `closeStopPopup` calls the injected `closeReach` so closing a stop
 * popup (or any funnel that does) also ends directions (found in review).
 */
export function createPopupController({
  map,
  el,
  reducedMotion,
  route,
  applyCameraPadding,
  closeReach,
  spiderfy,
}: {
  map: maplibregl.Map;
  el: HTMLElement;
  reducedMotion: MediaQueryList;
  route: RoutePathController;
  applyCameraPadding: (hasResults: boolean) => EdgeInsets;
  /** Ends the directions view (the other active map surface) — arbiter. */
  closeReach: () => void;
  /** Fan a non-splittable mark's members out as individual marks (task 061 W20). */
  spiderfy: (hub: [number, number], leaves: readonly Amenity[]) => void;
}) {
  let currentPopup: maplibregl.Popup | null = null;
  let popupCategory: AmenityCategoryKey | null = null;
  // The ring band of the place an open POI popup describes (task 065). Tracked for the
  // same reason as `popupCategory`: when the user narrows the ring filter, a popup for a
  // place in a now-unshaded band must close, or it describes somewhere outside the area
  // the map is claiming to show. Null for surfaces that are not one banded place
  // (a cluster spans bands, so it stays null). Set by `openPoiPopup` from the feature and
  // by `openStopPopup` from the band its caller threads in.
  let popupBand: number | null = null;
  let stopLinesAbort: AbortController | null = null;
  let stopLinesGen = 0;
  // Invalidates in-flight async cluster expansion (see openClusterPopup).
  let clusterGen = 0;

  /** Absorbed unclustered pins, read from the rendered source by feature id. */
  function featuresByIds(ids: number[]): LeafFeature[] {
    const wanted = new Set(ids);
    const out: LeafFeature[] = [];
    const seen = new Set<number>();
    let rendered: maplibregl.GeoJSONFeature[] = [];
    try {
      rendered = map.querySourceFeatures("amenities", { filter: ["!", ["has", "point_count"]] });
    } catch {
      return out;
    }
    for (const f of rendered) {
      const id = Number(f.id);
      if (!wanted.has(id) || seen.has(id)) continue;
      seen.add(id);
      out.push({ properties: f.properties, geometry: f.geometry as LeafFeature["geometry"] });
    }
    return out;
  }

  // Build the popup DOM from the pure model. A row whose line carries a
  // relationId becomes a BUTTON that draws the line's full path + stops (task
  // 024); rows without one stay informational.
  function renderStopPopup(model: StopPopupModel, anchor: [number, number]): HTMLElement {
    const root = document.createElement("div");
    root.className = "hf-stop-popup";
    root.dataset.testid = "stop-popup";
    root.dataset.state = model.kind;

    const title = document.createElement("div");
    title.className = "hf-stop-popup__title";
    title.textContent = model.title;
    root.appendChild(title);

    const message = (text: string) => {
      const m = document.createElement("div");
      m.className = "hf-stop-popup__msg";
      m.textContent = text;
      root.appendChild(m);
    };

    if (model.kind === "loading") message(STOP_POPUP_TEXT.loading);
    else if (model.kind === "error") message(STOP_POPUP_TEXT.error);
    else if (model.kind === "empty") message(STOP_POPUP_TEXT.empty);
    else {
      const list = document.createElement("ul");
      list.className = "hf-stop-popup__lines";
      for (const row of model.rows) {
        const li = document.createElement("li");
        li.className = "hf-stop-popup__line";

        const label = document.createElement("span");
        label.className = "hf-stop-popup__ref";
        label.textContent = `${row.modeLabel} ${row.ref}`;

        const parts: HTMLElement[] = [label];
        if (row.direction) {
          const dir = document.createElement("span");
          dir.className = "hf-stop-popup__dir";
          dir.textContent = `→ ${row.direction}`;
          parts.push(dir);
        }

        if (row.relationId) {
          const relationId = row.relationId;
          const button = document.createElement("button");
          button.type = "button";
          button.className = "hf-stop-popup__route";
          button.title = "Show this line's route and stops";
          for (const part of parts) button.appendChild(part);
          button.addEventListener("click", () => route.toggleRoutePath(relationId, button, anchor));
          if (relationId === route.getActiveRelationId()) route.setActiveRouteButton(button, "active");
          li.appendChild(button);
        } else {
          for (const part of parts) li.appendChild(part);
        }
        list.appendChild(li);
      }
      root.appendChild(list);
      if (model.partial) message(STOP_POPUP_TEXT.partial);
    }
    return root;
  }

  // Generic amenity info popup (task 024): name + category for any marker that
  // is not an identifiable transit stop. Same XSS posture (textContent only).
  // This is the mounting point for per-place details (e.g. reviews) later.
  function renderPoiPopup(name: string, category: string): HTMLElement {
    const root = document.createElement("div");
    root.className = "hf-stop-popup";
    root.dataset.testid = "poi-popup";
    root.dataset.state = "ready";

    const label = amenityCategoryLabel(category);
    const title = document.createElement("div");
    title.className = "hf-stop-popup__title";
    title.textContent = name || label; // unnamed POIs fall back to the category
    root.appendChild(title);

    if (name) {
      const sub = document.createElement("div");
      sub.className = "hf-stop-popup__msg";
      sub.textContent = label;
      root.appendChild(sub);
    }
    return root;
  }

  function openPoiPopup(feature: maplibregl.MapGeoJSONFeature, coords: [number, number]) {
    closeStopPopup(); // shared popup slot: replaces any open popup + aborts its fetch
    const props = feature.properties ?? {};
    const name = typeof props.name === "string" ? props.name.trim() : "";
    const category = typeof props.category === "string" ? props.category : "";
    const popup = new (mapGl().Popup)({ closeButton: true, closeOnClick: false, maxWidth: "280px" })
      .setLngLat(coords)
      .setDOMContent(renderPoiPopup(name, category))
      .addTo(map);
    currentPopup = popup;
    popupCategory = normalizeAmenitySelection([category])[0] ?? null;
    popupBand = typeof props.band === "number" ? props.band : null;
    popup.on("close", () => {
      if (currentPopup === popup) currentPopup = null;
      popupCategory = null;
      popupBand = null;
    });
  }

  // The transit stops a picked feature resolves to: a merged marker carries its
  // absorbed stops in `members` (task 047, string prop on a WebGL feature or a
  // raw array on the keyboard synthetic feature); an ordinary marker resolves to
  // its own single OSM identity. Empty ⇒ no usable identity to look up lines.
  function transitStopsOf(
    props: Record<string, unknown>,
    coords: [number, number],
  ): TransitStopMember[] {
    const members = parseAmenityMembers(props.members);
    if (members.length) return members;
    const osmType = typeof props.osmType === "string" ? props.osmType : "";
    const osmId = Number(props.osmId);
    const name = typeof props.name === "string" ? props.name : "";
    if (osmType && Number.isInteger(osmId) && osmId > 0) {
      return [{ osmType, osmId, name, lat: coords[1], lng: coords[0] }];
    }
    return [];
  }

  // Popup title for a stop or merged cluster: a single stop keeps its name; a
  // merge (task 047) shows its distinct member names so a fused marker never
  // presents one member's name over another's lines (review finding F1).
  function stopPopupTitle(stops: TransitStopMember[], fallback: string): string {
    if (stops.length <= 1) return fallback;
    const distinct: string[] = [];
    for (const s of stops) {
      const n = s.name.trim();
      if (n && !distinct.includes(n)) distinct.push(n);
    }
    if (distinct.length === 0) return fallback;
    if (distinct.length <= 2) return distinct.join(" / ");
    return `${distinct.slice(0, 2).join(" / ")} +${distinct.length - 2}`;
  }

  // Route a picked amenity to its popup: an identifiable transit stop (or merged
  // cluster) gets the line list; everything else — including a transit stop with
  // no usable OSM identity — gets the generic info popup (never silence, task 024).
  function openAmenityPopup(feature: maplibregl.MapGeoJSONFeature, coords: [number, number]) {
    const props = (feature.properties ?? {}) as Record<string, unknown>;
    const name = typeof props.name === "string" ? props.name : "";
    if (props.category === "transit") {
      const stops = transitStopsOf(props, coords);
      // Thread the band in: transit stops are the category most likely to sit far out, so
      // this is the popup the ring-filter close matters MOST for. `openPoiPopup` reads the
      // band off the feature; the stop path has to be told explicitly because it takes
      // members, not a feature.
      const band = typeof props.band === "number" ? props.band : null;
      if (stops.length) return openStopPopup(stops, stopPopupTitle(stops, name), coords, band);
    }
    openPoiPopup(feature, coords);
  }

  /**
   * "N places here" — the FLOOR of the resolution ladder (task 061).
   *
   * Because clustering never dissolves, genuinely coincident places (mall units, a
   * school and its kindergarten) are a cluster at *every* zoom and can never be
   * separated by zooming or reached as individual pins. This list is what
   * guarantees they are still readable: every leaf, paginated by scrolling, each
   * row routing into the existing `inspectAmenity` path so the detail view and its
   * focus handling are the same ones the keyboard browser already uses.
   *
   * Leaves arrive from an async `getClusterLeaves`, so the caller passes a
   * generation token and this bails if the world moved on — a click followed by
   * Escape or a new selection must not resurrect a list over cleared state.
   */
  function renderClusterList(
    leaves: Amenity[],
    total: number,
    onPick: (item: Amenity) => void,
  ): HTMLElement {
    const root = document.createElement("div");
    root.className = "hf-cluster-popup";
    root.dataset.testid = "cluster-popup";

    const heading = document.createElement("p");
    heading.className = "hf-cluster-popup__title";
    heading.textContent = `${total} ${total === 1 ? "place" : "places"} here`;
    root.appendChild(heading);

    if (leaves.length < total) {
      const note = document.createElement("p");
      note.className = "hf-cluster-popup__note";
      note.textContent = `Showing the nearest ${leaves.length}.`;
      root.appendChild(note);
    }

    const list = document.createElement("ul");
    list.className = "hf-cluster-popup__list";
    for (const item of leaves) {
      const row = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "hf-cluster-popup__row";

      const swatch = document.createElement("span");
      swatch.className = "hf-cluster-popup__swatch";
      swatch.style.background = AMENITY_COLOR_BY_KEY[item.category] ?? "#8a8a8a";
      button.appendChild(swatch);

      const text = document.createElement("span");
      text.className = "hf-cluster-popup__text";
      const title = document.createElement("span");
      title.className = "hf-cluster-popup__name";
      // textContent throughout: OSM names are untrusted (the XSS guard).
      title.textContent = item.name || amenityCategoryLabel(item.category);
      const meta = document.createElement("span");
      meta.className = "hf-cluster-popup__meta";
      meta.textContent =
        typeof item.distanceMeters === "number" && Number.isFinite(item.distanceMeters)
          ? `${amenityCategoryLabel(item.category)} · ${formatDistance(item.distanceMeters)}`
          : amenityCategoryLabel(item.category);
      text.appendChild(title);
      text.appendChild(meta);
      button.appendChild(text);

      button.addEventListener("click", () => onPick(item));
      row.appendChild(button);
      list.appendChild(row);
    }
    root.appendChild(list);
    return root;
  }

  /**
   * Cluster click → zoom to split, or open the leaves list.
   *
   * `getClusterExpansionZoom` and `getClusterLeaves` are PROMISES, so between the
   * click and the resolution the user may have pressed Escape, picked a new
   * address, or entered the decluttered journey view. Every await is therefore
   * followed by a generation check: `closeStopPopup` (and any teardown that funnels
   * through it) bumps `clusterGen`, and a superseded continuation returns without
   * touching the map. Without this, a slow cluster response resurrects a popup over
   * cleared state.
   */
  async function openClusterPopup(
    clusterIds: number[],
    coords: [number, number],
    total: number,
    pinIds: number[] = [],
    pinSnapshot: readonly IdentifiedLeaf[] = [],
    keyboard = false,
  ) {
    const source = map.getSource("amenities") as maplibregl.GeoJSONSource | undefined;
    // A mark can be pin-ONLY (two unclustered pins merged by the screen-space pass),
    // in which case there are no supercluster ids at all — bailing on that made the
    // mark inert while its pins were hidden from the pin layer, i.e. unreachable.
    if (!source || (clusterIds.length === 0 && pinIds.length === 0)) return;
    const gen = ++clusterGen;

    // Absorbed pins come from the snapshot the CONTROLLER took when it built the mark
    // (found in review). Two rounds of fixes went through this line: first
    // it re-queried the source after the cluster API resolved (so a zoom mid-await
    // dropped the place), then before the await (better, but still a second
    // `querySourceFeatures` that can miss an id at a viewport edge or mid-recluster —
    // and a miss made the mark a DEAD CLICK, the "on screen, unreachable" defect this
    // task exists to remove). The mark itself knows what it swallowed, so absorbed
    // reachability no longer depends on any re-query. `featuresByIds` remains only as
    // a fallback for a caller that has ids but no snapshot.
    // Snapshot FIRST, then fill any gap by re-query (found in review): the
    // mark builds `pins` with a `.filter(Boolean)`, so it can legitimately be SHORTER
    // than `pinIds` — and the absorbed-pin layer filter hides the full `pinIds` set, so
    // a member missing from the snapshot would be hidden AND unlistable. Preferring the
    // snapshot wholesale, as the first cut did, made that gap permanent.
    const snapshotById = new Map(pinSnapshot.map((p) => [p.id, p]));
    const missingIds = pinIds.filter((id) => !snapshotById.has(id));
    const absorbedFeatures: LeafFeature[] = [
      ...pinIds.filter((id) => snapshotById.has(id)).map((id) => snapshotById.get(id) as LeafFeature),
      ...(missingIds.length > 0 ? featuresByIds(missingIds) : []),
    ];

    // A mark can represent SEVERAL superclusters (screen-space agglomeration merges
    // donuts whose footprints would collide). Zooming can only help if EVERY one of
    // them can still split — if any is a coincident group, zooming would leave the
    // user clicking a mark that never opens, so the list is the right answer.
    let expansionZoom = Number.NaN;
    try {
      // No supercluster ids ⇒ nothing to expand; go straight to the list.
      const zooms = clusterIds.length
        ? await Promise.all(clusterIds.map((id) => source.getClusterExpansionZoom(id)))
        : [];
      expansionZoom = zooms.length ? Math.max(...zooms) : Number.NaN;
    } catch {
      expansionZoom = Number.NaN; // fall through to the always-correct list branch
    }
    if (gen !== clusterGen) return;

    // The ladder is one pure decision (`decideMarkAction`); this function only carries
    // it out. Leaves are not known yet, so the zoom rung is evaluated first and the
    // fan/list choice is re-decided below once they are.
    const zoomAction = decideMarkAction({
      expansionZoom,
      maxZoom: map.getMaxZoom(),
      clusterCount: clusterIds.length,
      pinCount: pinIds.length,
      // Unknown at this point; only the zoom rung can fire here.
      leafCount: 0,
      total,
      coincident: false,
      keyboard,
    });
    if (zoomAction.kind === "zoom") {
      const action = zoomAction;
      // The shared popup slot must be released here as well (review: three
      // reviewers). Every other branch closes it, so clicking a splittable donut while a
      // POI popup was open used to leave that stale detail card floating over a map
      // that had zoomed somewhere else.
      closeStopPopup();
      map.easeTo({
        center: coords,
        zoom: action.zoom,
        padding: applyCameraPadding(true),
        duration: reducedMotion.matches ? 0 : 450,
      });
      return;
    }

    let leaves: Amenity[] = [];
    try {
      // PAGED (found in review): one `getClusterLeaves` call returns at most
      // `CLUSTER_LEAF_PAGE` leaves, but a cluster can legally hold up to
      // `MAX_CLUSTER_LEAVES` (cap x 5 categories x 3 bands). Fetching a single page
      // silently made later leaves
      // unreachable while the popup still claimed to list the place — so walk the
      // offsets until the cluster's own `point_count` is covered.
      const raw = await collectClusterLeaves(
        clusterIds,
        (id, limit, offset) =>
          source.getClusterLeaves(id, limit, offset) as unknown as Promise<LeafFeature[]>,
        () => gen === clusterGen,
      );
      if (raw === null) return; // superseded mid-walk
      // Unclustered pins absorbed into this mark (the absorbed-pin case) belong to no supercluster, so
      // they were snapshotted from the source at click time and are listed alongside.
      leaves = leavesToAmenities([...raw, ...absorbedFeatures]);
    } catch {
      leaves = [];
    }
    if (gen !== clusterGen) return;
    if (leaves.length === 0) {
      // A visible mark must never be a silent no-op (found in review): the
      // pins it represents are hidden by the absorbed filter, so "nothing happened" is
      // indistinguishable from the unreachable-place defect this task removes. Say so
      // instead, with the count we do know.
      openClusterErrorPopup(coords, total);
      return;
    }
    // A cluster of one resolves straight to its detail — no point making the user click
    // through a list of length 1. Guarded on `total === 1` (found in review): if leaf
    // resolution dropped members, this shortcut would show ONE place with no hint that the
    // mark held more, which is the one disclosure the rest of the ladder always makes.
    if (leaves.length === 1 && total <= 1) {
      inspectAmenity(leaves[0]);
      return;
    }
    // The resolution ladder's middle rung (task 061 W20): a mark that cannot be
    // split by zooming FANS its members out, so they are seen on the map rather than
    // only read in a list. Four conditions, every one of them about honesty — a fan
    // draws its members at DECORATIVE offsets, so it may only be used where those
    // offsets cannot misrepresent where the places are:
    //
    // - ONE supercluster and no absorbed pins. A merged mark is places whose
    //   centroids merely collided in SCREEN space (see `agglomerateClusters`); their
    //   leaves keep different real coordinates, so fanning one drew pins where no
    //   place is, and clicking a leaf flew the camera away from it because
    //   `inspectAmenity` centres on the true coordinate (found in review).
    // - Genuinely coincident. The direct property, independent of HOW the mark formed:
    //   a cluster that cannot split at the map maximum holds members within about a
    //   metre, so anything wider than `SPIDER_MAX_SPAN_M` is two different places and
    //   belongs in the list.
    // - `leaves.length <= SPIDER_MAX_LEAVES`: beyond that a fan is less legible than
    //   the list it would replace, so the list stays the answer.
    // - `leaves.length >= total`: fan only what we could actually enumerate. If a
    //   leaf was dropped (unusable geometry, unknown category) the fan would silently
    //   show fewer places than the hub counts, and a mark that under-reports is the
    //   defect this task exists to remove. The list says "N of M" instead.
    const action = decideMarkAction({
      expansionZoom,
      maxZoom: map.getMaxZoom(),
      clusterCount: clusterIds.length,
      pinCount: pinIds.length,
      leafCount: leaves.length,
      total,
      coincident: leavesAreCoincident(leaves),
      keyboard,
    });
    if (action.kind === "fan") {
      // Same shared-slot discipline as the list and zoom branches: a stale POI card
      // must not sit over a fan that just decluttered the map for it.
      closeStopPopup();
      spiderfy(coords, leaves);
      return;
    }
    openClusterListPopup(coords, leaves, Math.max(total, leaves.length), keyboard);
  }

  /** Open the leaves list for a cluster. `leaves` is already resolved by the
   * caller (which owns the generation guard around the async cluster API). */
  /** The mark is on screen but its members could not be resolved. Better an honest
   * card than a dead click. */
  function openClusterErrorPopup(coords: [number, number], total: number) {
    closeStopPopup();
    const root = document.createElement("div");
    root.className = "hf-cluster-popup";
    root.dataset.testid = "cluster-popup";
    root.dataset.state = "error";
    const heading = document.createElement("div");
    heading.className = "hf-cluster-popup__title";
    heading.textContent = `${total} ${total === 1 ? "place" : "places"} here`;
    const note = document.createElement("div");
    note.className = "hf-cluster-popup__note";
    note.textContent = "Details could not be loaded. Try again in a moment.";
    root.appendChild(heading);
    root.appendChild(note);
    const popup = new (mapGl().Popup)({ closeButton: true, closeOnClick: false, maxWidth: "268px" })
      .setLngLat(coords)
      .setDOMContent(root)
      .addTo(map);
    currentPopup = popup;
    popupCategory = null;
    popupBand = null;
    // Same lifecycle marker discipline as the list, so a recluster closes this too.
    el.dataset.amenityClusterError = String(total);
    popup.on("close", () => {
      delete el.dataset.amenityClusterError;
      if (currentPopup === popup) currentPopup = null;
    });
  }

  function openClusterListPopup(
    coords: [number, number],
    leaves: Amenity[],
    total: number,
    keyboard = false,
  ) {
    closeStopPopup(); // shared popup slot
    const content = renderClusterList(leaves, total, (item) => {
      // Route into the normal detail path; it replaces this popup in the shared slot.
      inspectAmenity(item);
    });
    const popup = new (mapGl().Popup)({ closeButton: true, closeOnClick: false, maxWidth: "268px" })
      .setLngLat(coords)
      .setDOMContent(content)
      .addTo(map);
    currentPopup = popup;
    // A cluster spans categories, so it is not owned by one — leave popupCategory
    // null so a category toggle cannot half-close it (the amenity controller's
    // hidden-category close only applies to single-category popups).
    popupCategory = null;
    popupBand = null;
    popup.on("close", () => {
      if (currentPopup === popup) currentPopup = null;
    });
    el.dataset.amenityClusterList = String(leaves.length);
    popup.on("close", () => delete el.dataset.amenityClusterList);

    // Keyboard parity with `inspectAmenity` (found in review): a keyboard
    // user who activated a donut had focus left on a button that the recluster is about
    // to rebuild, and Escape did nothing. The list is also the rung keyboard
    // activations are routed to, so it is the one that MUST be operable.
    if (!keyboard) return;
    const returnTarget = document.querySelector<HTMLElement>('[data-testid="amenity-browser-trigger"]');
    popup.getElement().dataset.keyboardManaged = "true";
    popup.on("close", () => returnTarget?.focus());
    popup.getElement().addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      popup.remove();
    });
    focusKeyboardPopup(popup);
  }

  /**
   * Several unclustered markers under one click ⇒ list them instead of guessing.
   *
   * Clustering already aggregates anything closer than `CLUSTER_RADIUS_PX`, so this
   * is the residual near-miss case among individual pins. It closes the original
   * latent defect where the nearest-only pick left a clumped marker permanently
   * unreachable by pointer.
   */
  function openAmenityChoicePopup(
    hits: readonly { feature: maplibregl.MapGeoJSONFeature; coords: [number, number] }[],
    at: [number, number],
  ) {
    const items = leavesToAmenities(
      hits.map((h) => ({
        properties: h.feature.properties as Record<string, unknown>,
        geometry: { type: "Point", coordinates: h.coords },
      })),
    );
    if (items.length === 0) return;
    if (items.length === 1) return void openAmenityPopup(hits[0].feature, hits[0].coords);
    // Anchor on the FIRST (nearest) hit rather than the raw cursor point, so the
    // popup tip lands on a real marker.
    openClusterListPopup(hits[0].coords ?? at, items, items.length);
  }

  // Keyboard-accessible companion to the WebGL markers. It feeds the same popup
  // router, frames the chosen place inside the shared camera corridor, then moves
  // focus to MapLibre's close button so the detail is operable.
  function inspectAmenity(item: Amenity) {
    el.dataset.amenityInspect = "opening";
    const returnTarget = document.querySelector<HTMLElement>('[data-testid="amenity-browser-trigger"]');
    const coords: [number, number] = [item.lng, item.lat];
    const feature = {
      type: "Feature",
      properties: {
        name: item.name,
        category: item.category,
        osmType: item.osmType,
        osmId: item.osmId,
        // Band must survive the keyboard/Browse path too, or a popup opened from the list
        // cannot be closed when the ring filter narrows past its band.
        ...(item.band === undefined ? {} : { band: item.band }),
        // Merged transit marker (task 047): pass members through so the keyboard
        // path unions the same lines as a WebGL-marker click. Raw array here;
        // parseAmenityMembers accepts array or the WebGL JSON string alike.
        members: item.members,
      },
      geometry: { type: "Point", coordinates: coords },
    } as unknown as maplibregl.MapGeoJSONFeature;
    map.flyTo({
      center: coords,
      zoom: Math.max(14, map.getZoom()),
      padding: applyCameraPadding(true),
      essential: false,
      duration: reducedMotion.matches ? 0 : 650,
    });
    openAmenityPopup(feature, coords);
    const popup = currentPopup;
    if (!popup) {
      el.dataset.amenityInspect = "unavailable";
      return;
    }
    el.dataset.amenityInspect = item.name || amenityCategoryLabel(item.category);
    popup.getElement().dataset.keyboardManaged = "true";
    popup.on("close", () => returnTarget?.focus());
    popup.getElement().addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        popup.remove();
        return;
      }
      // MapLibre places its close control after the supplied content in DOM
      // order. Make the visual close -> details order explicit for keyboard
      // users, and keep Shift+Tab symmetrical when a route row is present.
      const close = popup.getElement().querySelector<HTMLButtonElement>(".maplibregl-popup-close-button");
      const firstAction = popup.getElement().querySelector<HTMLButtonElement>(".hf-stop-popup__route");
      if (event.key === "Tab" && !event.shiftKey && event.target === close && firstAction) {
        event.preventDefault();
        firstAction.focus();
      } else if (event.key === "Tab" && event.shiftKey && event.target === firstAction && close) {
        event.preventDefault();
        close.focus();
      }
    });
    focusKeyboardPopup(popup);
  }

  // Async transit details can update a popup after keyboard focus has moved into
  // it. Restore focus to its stable close control after each replacement so
  // loading -> ready/error never drops the user back to the document body.
  function focusKeyboardPopup(popup: maplibregl.Popup) {
    if (popup.getElement().dataset.keyboardManaged !== "true") return;
    requestAnimationFrame(() => {
      if (currentPopup !== popup) return;
      popup.getElement().querySelector<HTMLButtonElement>(".maplibregl-popup-close-button")?.focus();
    });
  }

  function updateStopPopup(popup: maplibregl.Popup, model: StopPopupModel, coords: [number, number]) {
    popup.setDOMContent(renderStopPopup(model, coords));
    focusKeyboardPopup(popup);
  }

  // Tear down the stop/POI popup AND invalidate its in-flight fetch (bumping the
  // gen so a late response can't repaint a removed popup). Called on a new stop
  // click and at the start of any new selection. Also ends any directions view
  // via the arbiter, so the two active map surfaces never coexist (found in review)
  // and every selection/mode/dispose funnel that clears the popup also clears the
  // drawn journey + declutter + destination pin (they live in the directions
  // controller now, task 058).
  function closeStopPopup() {
    stopLinesAbort?.abort();
    stopLinesGen += 1;
    // Also invalidates any in-flight cluster expansion, so a slow
    // getClusterLeaves cannot repaint a list after this teardown (task 061).
    clusterGen += 1;
    closeReach();
    currentPopup?.remove();
    currentPopup = null;
    popupCategory = null;
    popupBand = null;
    delete el.dataset.amenityClusterList;
  }

  // Fetch one stop's serving lines. Resolves with its lines (possibly empty —
  // a valid "no mapped routes"); rejects on abort/non-ok/network so the batch
  // can tell a genuine failure from an empty result.
  async function fetchStopLines(stop: TransitStopMember, signal: AbortSignal): Promise<StopLine[]> {
    const q =
      `?type=${encodeURIComponent(stop.osmType)}&id=${stop.osmId}` +
      `&lat=${stop.lat}&lng=${stop.lng}&name=${encodeURIComponent(stop.name)}`;
    const res = await fetch(`/api/stop-lines${q}`, { signal });
    if (!res.ok) throw new Error(`stop-lines ${res.status}`);
    const data = (await res.json()) as { lines?: unknown };
    return (Array.isArray(data.lines) ? data.lines : []) as StopLine[];
  }

  // Open the transit line popup for one or more stops. A merged marker (task
  // 047) fans out over its members under ONE batch deadline / abort / generation
  // and renders the UNION of the members that responded — the popup errors only
  // if EVERY member fails, and flags a partial union when some did. A single
  // stop is just the one-member case (behaviour unchanged from task 021).
  function openStopPopup(
    stops: TransitStopMember[],
    title: string,
    coords: [number, number],
    band: number | null = null,
  ) {
    closeStopPopup();
    // No usable identity ⇒ can't look up lines. Bail with no popup — but the
    // caller has ALREADY decided this is a transit hit, so we never fall through
    // to a reselection that would wipe the user's markers (task 021).
    if (stops.length === 0) return;
    // Set AFTER `closeStopPopup()` above, which nulls it.
    popupBand = band;

    const gen = stopLinesGen;
    const controller = new AbortController();
    stopLinesAbort = controller;

    const popup = new (mapGl().Popup)({ closeButton: true, closeOnClick: false, maxWidth: "280px" })
      .setLngLat(coords)
      .setDOMContent(renderStopPopup(buildStopPopupModel(title, "loading"), coords))
      .addTo(map);
    currentPopup = popup;
    popupCategory = "transit";
    // ANY way this popup goes away (its ×, replacement by another popup, a new
    // selection, a mode toggle, unmount — all end in Popup.remove, which fires
    // `close`) also clears the line path drawn from it.
    popup.on("close", route.clearRoutePath);
    popup.on("close", () => {
      if (currentPopup === popup) currentPopup = null;
      popupCategory = null;
    popupBand = null;
    });

    // ONE client deadline for the whole batch: transition to error (and abort
    // every member fetch) if the server is slow, so the popup never sits on
    // "Finding lines…" indefinitely.
    const timer = setTimeout(() => {
      if (gen === stopLinesGen) {
        updateStopPopup(popup, buildStopPopupModel(title, "error"), coords);
      }
      controller.abort();
    }, STOP_LINES_TIMEOUT_MS);

    Promise.allSettled(stops.map((stop) => fetchStopLines(stop, controller.signal)))
      .then((results) => {
        if (gen !== stopLinesGen) return;
        const ok = results.filter(
          (r): r is PromiseFulfilledResult<StopLine[]> => r.status === "fulfilled",
        );
        if (ok.length === 0) {
          updateStopPopup(popup, buildStopPopupModel(title, "error"), coords);
          return;
        }
        const lines = mergeStopLines(ok.map((r) => r.value));
        const partial = ok.length < stops.length;
        updateStopPopup(popup, buildStopPopupModel(title, "ready", lines, partial), coords);
      })
      .finally(() => clearTimeout(timer));
  }

  return {
    openAmenityPopup,
    openAmenityChoicePopup,
    openClusterPopup,
    /** the absorbed-pin case: a recluster (`setData`) re-indexes cluster ids, so any in-flight leaf
     * lookup now refers to ids that no longer mean the same thing, and an open list
     * can describe places that are no longer shown. Treat it as a teardown for
     * cluster async — the same discipline `resetAmenityHover` applies to feature ids
     * on that very same `setData`. */
    invalidateClusters() {
      clusterGen += 1;
      // EVERY cluster-derived popup, not just the list: the failure card reports a
      // cluster total too, so leaving it open after a recluster lets it keep describing
      // places that are no longer shown (found in review).
      if (
        el.dataset.amenityClusterList !== undefined ||
        el.dataset.amenityClusterError !== undefined
      ) {
        closeStopPopup();
      }
    },
    inspectAmenity,
    closeStopPopup,
    /** The category of the currently-open popup, so a hidden-category filter can
     * close it (amenities-controller reads this — never the private field). */
    getPopupCategory: () => popupCategory,
    getPopupBand: () => popupBand,
    dispose() {
      closeStopPopup();
    },
  };
}

export type PopupController = ReturnType<typeof createPopupController>;
