import maplibregl from "maplibre-gl";

import {
  amenityCategoryLabel,
  parseAmenityMembers,
  type Amenity,
  type AmenityCategoryKey,
  type TransitStopMember,
} from "@/features/amenities/amenities";
import { normalizeAmenitySelection } from "@/features/amenities/amenity-selection";
import { mergeStopLines, type StopLine } from "@/features/amenities/stop-lines";
import { buildStopPopupModel, STOP_POPUP_TEXT, type StopPopupModel } from "@/features/amenities/stop-popup";
import type { ReachPlan } from "@/features/isochrones/server/transit-plan";
import { buildReachSteps, carReachText, isWalkOnly, reachSummary, walkReachText, type ReachRequest } from "@/features/map/reach";
import type { EdgeInsets } from "@/features/map/route-framing";
import type { RoutePathController } from "@/features/map/route-path-controller";

/** Client-side deadline on the stop-lines fetch so a degraded Overpass can't
 * leave the popup on "Finding lines…" for the server's full host budget (task
 * 021 — the "never hang on loading" lesson). */
const STOP_LINES_TIMEOUT_MS = 9000;
/** Client deadline on the /api/reach trip plan so a slow MOTIS can't leave the
 * popup on "Planning your trip…" forever (task 052 D). Generous — /plan is
 * ~0.6s server but a cold cache + rate-limit wait can stack. */
const REACH_TIMEOUT_MS = 12000;

/**
 * The shared popup slot (task 021/024): one MapLibre popup at a time, routing a
 * picked amenity to either the transit stop-lines list or the generic POI info
 * card, plus the keyboard-accessible `inspectAmenity` companion to the WebGL
 * markers. DOM is built with `textContent` only (OSM names/headsigns are
 * untrusted — the XSS guard); the pure popup *model* is `buildStopPopupModel`.
 * A row carrying a relationId becomes a button that asks the route controller to
 * draw the line. `dispose` aborts the in-flight stop-lines fetch and removes the
 * popup. Reads route state only through its exposed getter, never private fields.
 */
export function createPopupController({
  map,
  el,
  reducedMotion,
  route,
  applyCameraPadding,
}: {
  map: maplibregl.Map;
  el: HTMLElement;
  reducedMotion: MediaQueryList;
  route: RoutePathController;
  applyCameraPadding: (hasResults: boolean) => EdgeInsets;
}) {
  let currentPopup: maplibregl.Popup | null = null;
  let popupCategory: AmenityCategoryKey | null = null;
  let stopLinesAbort: AbortController | null = null;
  let stopLinesGen = 0;
  let reachAbort: AbortController | null = null;
  let reachGen = 0;

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
    const popup = new maplibregl.Popup({ closeButton: true, closeOnClick: false, maxWidth: "280px" })
      .setLngLat(coords)
      .setDOMContent(renderPoiPopup(name, category))
      .addTo(map);
    currentPopup = popup;
    popupCategory = normalizeAmenitySelection([category])[0] ?? null;
    popup.on("close", () => {
      if (currentPopup === popup) currentPopup = null;
      popupCategory = null;
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
  // presents one member's name over another's lines (impl-panel finding F1).
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
      if (stops.length) return openStopPopup(stops, stopPopupTitle(stops, name), coords);
    }
    openPoiPopup(feature, coords);
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

  // Tear down the popup AND invalidate its in-flight fetch (bumping the gen so a
  // late response can't repaint a removed popup). Called on a new stop click and
  // at the start of any new selection.
  function closeStopPopup() {
    stopLinesAbort?.abort();
    stopLinesGen += 1;
    reachAbort?.abort();
    reachGen += 1;
    delete el.dataset.reachState;
    currentPopup?.remove();
    currentPopup = null;
    popupCategory = null;
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
  ) {
    closeStopPopup();
    // No usable identity ⇒ can't look up lines. Bail with no popup — but the
    // caller has ALREADY decided this is a transit hit, so we never fall through
    // to a reselection that would wipe the user's markers (task 021).
    if (stops.length === 0) return;

    const gen = stopLinesGen;
    const controller = new AbortController();
    stopLinesAbort = controller;

    const popup = new maplibregl.Popup({ closeButton: true, closeOnClick: false, maxWidth: "280px" })
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

  // --- Right-click "how do I get there?" reach popup (task 052 D) ----------
  // A small heading + detail, plus (for a planned transit trip) an ordered step
  // list. All text via textContent (OSM stop names / line headsigns are
  // untrusted). `state` drives an el-level `data-reach-state` stamp for e2e.
  type ReachRender =
    | { state: "hint" | "loading" | "none" | "error" | "outside"; title: string; detail: string }
    | { state: "walk"; title: string; detail: string }
    | { state: "car"; title: string; detail: string }
    | { state: "transit"; title: string; detail: string; steps: { primary: string; secondary: string }[] };

  function renderReachPopup(model: ReachRender): HTMLElement {
    const root = document.createElement("div");
    root.className = "hf-stop-popup hf-reach-popup";
    root.dataset.testid = "reach-popup";
    root.dataset.state = model.state;

    const title = document.createElement("div");
    title.className = "hf-stop-popup__title";
    title.textContent = model.title;
    root.appendChild(title);

    if (model.detail) {
      const detail = document.createElement("div");
      detail.className = "hf-stop-popup__msg";
      detail.textContent = model.detail;
      root.appendChild(detail);
    }

    if (model.state === "transit") {
      const list = document.createElement("ol");
      list.className = "hf-reach-popup__steps";
      for (const step of model.steps) {
        const li = document.createElement("li");
        li.className = "hf-reach-popup__step";
        const primary = document.createElement("span");
        primary.className = "hf-reach-popup__step-primary";
        primary.textContent = step.primary;
        const secondary = document.createElement("span");
        secondary.className = "hf-reach-popup__step-secondary";
        secondary.textContent = step.secondary;
        li.append(primary, secondary);
        list.appendChild(li);
      }
      root.appendChild(list);
    }
    return root;
  }

  function stampReach(state: string) {
    el.dataset.reachState = state;
  }

  function showReach(model: ReachRender, coords: [number, number], popup?: maplibregl.Popup) {
    const content = renderReachPopup(model);
    stampReach(model.state);
    if (popup) {
      popup.setDOMContent(content);
      return popup;
    }
    const next = new maplibregl.Popup({ closeButton: true, closeOnClick: false, maxWidth: "300px" })
      .setLngLat(coords)
      .setDOMContent(content)
      .addTo(map);
    currentPopup = next;
    next.on("close", () => {
      // Closing the popup (× / replacement / new selection) must also cancel any
      // in-flight /api/reach fetch and its deadline, bump the generation so a
      // late response can't repaint, and clear the e2e stamp (T5 — avoid a stale
      // data-reach-state after the popup is gone).
      reachAbort?.abort();
      reachGen += 1;
      delete el.dataset.reachState;
      if (currentPopup === next) currentPopup = null;
    });
    return next;
  }

  /**
   * Open the reach popup for a right-click / long-press. Walk + the no-selection
   * hint render synchronously (client-side band); a transit request fetches the
   * planned trip from `/api/reach` under one deadline/abort/generation (mirrors
   * the stop-lines flow), then paints the steps or a not-reachable message.
   */
  function openReachPopup(req: ReachRequest) {
    closeStopPopup(); // shared slot: replace any open popup + cancel its fetch

    if (req.kind === "hint") {
      showReach(
        { state: "hint", title: "How do I get there?", detail: "Pick a starting point first, then right-click anywhere to see the way." },
        req.coords,
      );
      return;
    }
    if (req.kind === "walk") {
      const { title, detail } = walkReachText(req.band);
      showReach({ state: "walk", title, detail }, req.coords);
      return;
    }
    if (req.kind === "car") {
      // Car reach is a client-side drive band — no provider call, with the
      // estimate/no-live-traffic caveat baked into the copy (task 053, C-F).
      const { title, detail } = carReachText(req.band);
      showReach({ state: "car", title, detail }, req.coords);
      return;
    }
    if (req.kind === "transit-unreachable") {
      // Client point-in-ring said this point is outside the painted transit
      // reach — answer honestly with NO provider call (T1/P2).
      showReach(
        { state: "none", title: "Beyond your reach", detail: "This point is outside your public-transport reach for the selected time." },
        req.coords,
      );
      return;
    }

    // Transit (inside the band): loading → fetch → journey / none / error, under
    // one generation. `band` frames the trip time against the visible reach (P8).
    const band = req.band;
    const gen = ++reachGen;
    const controller = new AbortController();
    reachAbort = controller;
    const popup = showReach({ state: "loading", title: "Planning your trip…", detail: "Finding the best public-transport route." }, req.coords);

    const timer = setTimeout(() => {
      if (gen === reachGen) showReach({ state: "error", title: "Couldn’t plan this trip", detail: "The routing service is slow — please try again." }, req.coords, popup);
      controller.abort();
    }, REACH_TIMEOUT_MS);

    fetch(req.url, { signal: controller.signal })
      .then(async (res) => {
        if (gen !== reachGen) return;
        if (res.status === 422) {
          return void showReach({ state: "outside", title: "Outside the area", detail: "That point is outside the Bucharest area we cover." }, req.coords, popup);
        }
        if (!res.ok) {
          return void showReach({ state: "error", title: "Couldn’t plan this trip", detail: "Please try again in a moment." }, req.coords, popup);
        }
        const plan = (await res.json()) as ReachPlan;
        if (gen !== reachGen) return;
        if (!plan.reachable) {
          return void showReach({ state: "none", title: "No public-transport route", detail: "No trip was found for this departure time." }, req.coords, popup);
        }
        // A plan with no transit leg is really walking directions (T4).
        if (isWalkOnly(plan.legs)) {
          return void showReach(
            { state: "transit", title: "On foot", detail: `Within your ~${band}-min reach — about a ${plan.totalMinutes}-min walk.`, steps: buildReachSteps(plan.legs) },
            req.coords,
            popup,
          );
        }
        showReach(
          { state: "transit", title: "By public transport", detail: `Within your ~${band}-min reach — journey ${reachSummary(plan)}.`, steps: buildReachSteps(plan.legs) },
          req.coords,
          popup,
        );
      })
      .catch((err) => {
        if ((err as Error)?.name === "AbortError" || gen !== reachGen) return;
        showReach({ state: "error", title: "Couldn’t plan this trip", detail: "Please try again in a moment." }, req.coords, popup);
      })
      .finally(() => clearTimeout(timer));
  }

  return {
    openAmenityPopup,
    inspectAmenity,
    closeStopPopup,
    openReachPopup,
    /** The category of the currently-open popup, so a hidden-category filter can
     * close it (amenities-controller reads this — never the private field). */
    getPopupCategory: () => popupCategory,
    dispose() {
      closeStopPopup();
    },
  };
}

export type PopupController = ReturnType<typeof createPopupController>;
