import maplibregl from "maplibre-gl";

import {
  amenityCategoryLabel,
  type Amenity,
  type AmenityCategoryKey,
} from "@/features/amenities/amenities";
import { normalizeAmenitySelection } from "@/features/amenities/amenity-selection";
import type { StopLine } from "@/features/amenities/stop-lines";
import { buildStopPopupModel, STOP_POPUP_TEXT, type StopPopupModel } from "@/features/amenities/stop-popup";
import type { EdgeInsets } from "@/features/map/route-framing";
import type { RoutePathController } from "@/features/map/route-path-controller";

/** Client-side deadline on the stop-lines fetch so a degraded Overpass can't
 * leave the popup on "Finding lines…" for the server's full host budget (task
 * 021 — the "never hang on loading" lesson). */
const STOP_LINES_TIMEOUT_MS = 9000;

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

  // Route a picked amenity to its popup: an identifiable transit stop gets the
  // line list; everything else — including a transit stop with no usable OSM
  // identity — gets the generic info popup (never silence, task 024).
  function openAmenityPopup(feature: maplibregl.MapGeoJSONFeature, coords: [number, number]) {
    const props = feature.properties ?? {};
    const osmType = typeof props.osmType === "string" ? props.osmType : "";
    const osmId = Number(props.osmId);
    if (props.category === "transit" && osmType && Number.isInteger(osmId) && osmId > 0) {
      return openStopPopup(feature, coords);
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
    currentPopup?.remove();
    currentPopup = null;
    popupCategory = null;
  }

  function openStopPopup(feature: maplibregl.MapGeoJSONFeature, coords: [number, number]) {
    const props = feature.properties ?? {};
    const osmType = typeof props.osmType === "string" ? props.osmType : "";
    const osmId = Number(props.osmId);
    const name = typeof props.name === "string" ? props.name : "";
    closeStopPopup();
    // No usable identity ⇒ can't look up lines. Bail with no popup — but the
    // caller has ALREADY decided this is a transit hit, so we never fall through
    // to a reselection that would wipe the user's markers (task 021).
    if (!osmType || !Number.isInteger(osmId) || osmId <= 0) return;

    const gen = stopLinesGen;
    const controller = new AbortController();
    stopLinesAbort = controller;

    const popup = new maplibregl.Popup({ closeButton: true, closeOnClick: false, maxWidth: "280px" })
      .setLngLat(coords)
      .setDOMContent(renderStopPopup(buildStopPopupModel(name, "loading"), coords))
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

    // Client deadline: transition to the error state (and abort) if the server
    // is slow, so the popup never sits on "Finding lines…" indefinitely.
    const timer = setTimeout(() => {
      if (gen === stopLinesGen) {
        updateStopPopup(popup, buildStopPopupModel(name, "error"), coords);
      }
      controller.abort();
    }, STOP_LINES_TIMEOUT_MS);

    const q = `?type=${encodeURIComponent(osmType)}&id=${osmId}&lat=${coords[1]}&lng=${coords[0]}&name=${encodeURIComponent(name)}`;
    fetch(`/api/stop-lines${q}`, { signal: controller.signal })
      .then(async (res) => {
        if (gen !== stopLinesGen) return;
        if (!res.ok) return void updateStopPopup(popup, buildStopPopupModel(name, "error"), coords);
        const data = (await res.json()) as { lines?: unknown };
        if (gen !== stopLinesGen) return;
        const lines = (Array.isArray(data.lines) ? data.lines : []) as StopLine[];
        updateStopPopup(popup, buildStopPopupModel(name, "ready", lines), coords);
      })
      .catch((err) => {
        if ((err as Error)?.name === "AbortError" || gen !== stopLinesGen) return;
        updateStopPopup(popup, buildStopPopupModel(name, "error"), coords);
      })
      .finally(() => clearTimeout(timer));
  }

  return {
    openAmenityPopup,
    inspectAmenity,
    closeStopPopup,
    /** The category of the currently-open popup, so a hidden-category filter can
     * close it (amenities-controller reads this — never the private field). */
    getPopupCategory: () => popupCategory,
    dispose() {
      closeStopPopup();
    },
  };
}

export type PopupController = ReturnType<typeof createPopupController>;
