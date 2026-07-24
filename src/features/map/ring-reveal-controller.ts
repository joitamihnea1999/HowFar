import type maplibregl from "maplibre-gl";

import {
  RING_BANDS,
  ringLayerVisibility,
  ringRevealStages,
  type RingFilter,
} from "@/features/isochrones/isochrone-view";
import type { LoadState } from "@/features/map/load-state";
import { ISOCHRONE_FILL_OPACITY, ISOCHRONE_LINE_OPACITY } from "@/features/map/map-setup";

/** Staged All-mode ring reveal: start delay + per-band dwell (ms). Dwell is long
 * enough to be perceptible and for tests to observe paint without racing a
 * sub-poll-interval transient. */
const RING_REVEAL_START_MS = 80;
const RING_REVEAL_STAGE_MS = 280;

/**
 * Owns the isochrone ring paint: the staged All-mode reveal animation and the
 * filter→layer-visibility flip (task 024/028). The layers are created once at
 * `load` and persist across selections + mode toggles, so this is the only paint
 * work a filter change needs. The ordered stage sequence is the pure,
 * unit-tested `ringRevealStages`; this controller drives MapLibre paint/layout
 * properties and stamps the read-back attributes (`data-ring-reveal`,
 * `-sequence`, `-paint*`, `-ring-filter`, `-visible-rings`) the e2e suite
 * asserts. `dispose` clears the staged-reveal timers.
 */
export function createRingRevealController({
  map,
  el,
  loadState,
  reducedMotion,
  ringFilterRef,
}: {
  map: maplibregl.Map;
  el: HTMLElement;
  loadState: LoadState;
  reducedMotion: MediaQueryList;
  ringFilterRef: { current: RingFilter };
}) {
  let ringRevealTimers: Array<ReturnType<typeof setTimeout>> = [];

  function cancelRingReveal(clearReadback = true) {
    for (const timer of ringRevealTimers) clearTimeout(timer);
    ringRevealTimers = [];
    if (clearReadback) {
      delete el.dataset.ringReveal;
      delete el.dataset.ringRevealSequence;
      delete el.dataset.ringPaintTrace;
      delete el.dataset.ringPaint15;
      delete el.dataset.ringPaint30;
      delete el.dataset.ringPaint45;
    }
  }

  function setRingTransition(duration: number) {
    for (const minutes of RING_BANDS) {
      map.setPaintProperty(`iso-fill-${minutes}`, "fill-opacity-transition", { duration, delay: 0 });
      map.setPaintProperty(`iso-line-${minutes}`, "line-opacity-transition", { duration, delay: 0 });
    }
  }

  function stampRingPaintReadbacks() {
    for (const minutes of RING_BANDS) {
      el.dataset[`ringPaint${minutes}`] = String(
        map.getPaintProperty(`iso-fill-${minutes}`, "fill-opacity"),
      );
    }
  }

  /** Cumulative paint trace: each stage records live fill opacities in
   * RING_BANDS order (45,30,15). Tests assert the settled attribute instead
   * of racing a sub-poll-interval intermediate. */
  function appendRingPaintTrace(stage: string) {
    const paints = RING_BANDS.map((minutes) =>
      String(map.getPaintProperty(`iso-fill-${minutes}`, "fill-opacity")),
    ).join(",");
    const entry = `${stage}:${paints}`;
    const prev = el.dataset.ringPaintTrace;
    el.dataset.ringPaintTrace = prev ? `${prev}|${entry}` : entry;
  }

  function setRingRevealed(minutes: (typeof RING_BANDS)[number], revealed: boolean) {
    map.setPaintProperty(`iso-fill-${minutes}`, "fill-opacity", revealed ? ISOCHRONE_FILL_OPACITY : 0);
    map.setPaintProperty(`iso-line-${minutes}`, "line-opacity", revealed ? ISOCHRONE_LINE_OPACITY : 0);
    // Paint-property READ-BACK (not requested-state echo): keeps the signature
    // transition objectively testable through MapLibre's live style.
    stampRingPaintReadbacks();
  }

  // Largest-to-smallest reads as the city opening up, then resolving around
  // the selected address. The active ring filter still owns layer visibility;
  // this only animates the bands that are currently visible.
  function revealRings() {
    cancelRingReveal(false);
    delete el.dataset.ringPaintTrace;
    if (reducedMotion.matches) {
      setRingTransition(0); // no inherited 320ms fade under reduced motion
      for (const minutes of RING_BANDS) setRingRevealed(minutes, true);
      el.dataset.ringReveal = "settled";
      el.dataset.ringRevealSequence = "instant";
      appendRingPaintTrace("instant");
      return;
    }

    // Reveal what the user can actually see. A single-band filter resolves
    // that band immediately; All tells the full outer-to-inner story. Hidden
    // bands remain at their final opacity so changing filters never exposes a
    // band stranded at zero. The zero-duration hide prevents a flash/fade-out
    // before the reveal transition begins.
    const stages = ringRevealStages(ringFilterRef.current);
    setRingTransition(0);
    for (const minutes of stages) setRingRevealed(minutes, false);
    setRingTransition(320);
    el.dataset.ringReveal = "starting";
    el.dataset.ringRevealSequence = "";
    appendRingPaintTrace("start");
    const sequence: number[] = [];
    for (const [index, minutes] of stages.entries()) {
      ringRevealTimers.push(
        setTimeout(() => {
          setRingRevealed(minutes, true);
          sequence.push(minutes);
          el.dataset.ringReveal = String(minutes);
          el.dataset.ringRevealSequence = sequence.join(",");
          appendRingPaintTrace(String(minutes));
        }, RING_REVEAL_START_MS + index * RING_REVEAL_STAGE_MS),
      );
    }
    ringRevealTimers.push(
      setTimeout(() => {
        el.dataset.ringReveal = "settled";
        appendRingPaintTrace("settled");
        ringRevealTimers = [];
      }, RING_REVEAL_START_MS + (stages.length - 1) * RING_REVEAL_STAGE_MS + 340),
    );
  }

  // Flip the per-minute layers' visibility to match a ring filter. Cancels any
  // in-flight staged reveal and snaps every band to full opacity so a mid-reveal
  // switch (e.g. All → 15) never exposes a layout-visible band stuck at 0.
  function applyRingFilter(filter: RingFilter) {
    if (!loadState.styleLoaded) return; // load applies the current filter itself
    cancelRingReveal(false);
    setRingTransition(0);
    for (const minutes of RING_BANDS) setRingRevealed(minutes, true);
    el.dataset.ringReveal = "settled";
    if (!el.dataset.ringRevealSequence) el.dataset.ringRevealSequence = "filter";
    for (const [layerId, visibility] of Object.entries(ringLayerVisibility(filter))) {
      map.setLayoutProperty(layerId, "visibility", visibility);
    }
    el.dataset.ringFilter = String(filter);
    // Derived from a layer READ-BACK, not the requested filter: the e2e contract
    // is "these bands are visible on the map".
    el.dataset.visibleRings = [...RING_BANDS]
      .filter((m) => map.getLayoutProperty(`iso-fill-${m}`, "visibility") !== "none")
      .sort((a, b) => a - b)
      .join(",");
  }

  return {
    revealRings,
    applyRingFilter,
    cancelRingReveal,
    dispose() {
      cancelRingReveal();
    },
  };
}

export type RingRevealController = ReturnType<typeof createRingRevealController>;
