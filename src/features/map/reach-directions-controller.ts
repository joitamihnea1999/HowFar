import type { ReachPlan } from "@/features/isochrones/server/transit-plan";
import {
  buildReachSteps,
  hasTransitLeg,
  reachSummary,
  type ReachRequest,
} from "@/features/map/reach";
import type { ReachJourneyController } from "@/features/map/reach-journey-controller";
import type { EdgeInsets } from "@/features/map/route-framing";

/**
 * The right-click "how do I get there?" directions flow (task 058), extracted
 * from the popup controller (task 052/054/057). It no longer renders a
 * map-anchored MapLibre popup — the directions now live in the RESULT-SHEET DOCK
 * (owner item 2: "replace the useless filters with this so it doesn't cover the
 * map"). This controller owns the STATE + side effects only; a React panel
 * (`ReachPanel`) renders whatever `subscribe` reports.
 *
 * Responsibilities (ported verbatim from the popup version — the race handling
 * below was panel-caught and must not regress):
 *   - the reach view state machine (hint / outside / none / loading / error /
 *     transit-with-steps) — public-transport only since task 060;
 *   - the `/api/reach` fetch under ONE generation + abort + 12s deadline, with
 *     the "invalidate gen BEFORE abort" and "late-json guard" fixes;
 *   - orchestrating the drawn journey, amenity declutter, destination pin, and
 *     the camera frame;
 *   - the `data-reach-state` e2e stamp.
 *
 * Mutual exclusivity (panel opus-1): directions and the stop/POI popup are the
 * two "active map surfaces" and never coexist. `open()` closes any stop/POI
 * popup via the injected `closeStopPopup`; the popup controller's
 * `closeStopPopup` calls back into `close()` here — so every funnel that clears
 * one clears the other, in both directions.
 */

const REACH_TIMEOUT_MS = 12000;

export interface ReachStepView {
  primary: string;
  secondary: string;
  mode: string;
}

/** What `ReachPanel` renders. `state` drives the `data-reach-state` stamp and
 * the panel's test hooks; `steps` is present only for a drawn transit journey. */
export interface ReachView {
  state: "hint" | "outside" | "none" | "loading" | "error" | "transit";
  title: string;
  detail: string;
  steps?: ReachStepView[];
}

export function createReachDirectionsController({
  el,
  journey,
  reachDeclutter,
  applyCameraPadding,
  closeStopPopup,
}: {
  el: HTMLElement;
  journey: ReachJourneyController;
  /** Toggles amenity declutter while a journey is shown (holder — wired after
   * the amenities controller exists, like the popup version). */
  reachDeclutter: { set: (on: boolean) => void };
  applyCameraPadding: (hasResults: boolean) => EdgeInsets;
  /** Closes any open stop/POI popup — the other "active map surface". */
  closeStopPopup: () => void;
}) {
  let view: ReachView | null = null;
  let subscriber: ((v: ReachView | null) => void) | null = null;
  let reachAbort: AbortController | null = null;
  let reachGen = 0;

  function setView(next: ReachView | null) {
    view = next;
    if (next) el.dataset.reachState = next.state;
    else delete el.dataset.reachState;
    subscriber?.(next);
  }

  // Clear the drawn journey + declutter + destination pin. Idempotent (journey.
  // clear also drops the pin). Called by close() and by the mutual-exclusivity
  // callback, so a drawn journey never outlives the directions view.
  function teardown() {
    journey.clear();
    reachDeclutter.set(false);
  }

  /** Close the directions: abort any in-flight fetch (bumping the gen so a late
   * response can't repaint), tear down the drawn journey/pin/declutter, and
   * clear the view. Does NOT touch the stop/POI popup (that side is driven by
   * the arbiter to avoid recursion). */
  function close() {
    reachAbort?.abort();
    reachGen += 1;
    teardown();
    setView(null);
  }

  function open(req: ReachRequest) {
    // Self-contained invalidation (panel opus-1/grok-5): abort any in-flight
    // fetch, bump the gen so a late response can't draw, and tear down the prior
    // journey/pin/declutter — WITHOUT relying on the arbiter callback. A `hint`
    // open (or a re-open) otherwise leaves an in-flight transit fetch able to
    // draw over the new answer if `closeStopPopup` were ever mis-wired.
    reachAbort?.abort();
    reachGen += 1;
    teardown();
    // Arbiter: opening directions also closes any stop/POI popup (the other
    // active map surface). That funnels back through closeStopPopup → close()
    // here, which is idempotent after the invalidation above.
    closeStopPopup();

    // Anchor the answer with a destination pin for every real point (not the
    // no-selection hint) — there is no popup marking the click anymore.
    journey.setDestination(req.kind === "hint" ? null : req.coords);

    if (req.kind === "hint") {
      setView({
        state: "hint",
        title: "How do I get there?",
        detail: "Pick a starting point first, then right-click anywhere to see the way.",
      });
      return;
    }

    // Task 060: every right-click is a public-transport directions request (any
    // mode auto-switches to transit in AppMap first). loading → fetch → journey /
    // none / error, under one generation. `band` frames the trip time against the
    // visible reach (the point's ring band, or the 45-min transit max cross-mode).
    const band = req.band;
    const gen = ++reachGen;
    const controller = new AbortController();
    reachAbort = controller;
    setView({ state: "loading", title: "Planning your trip…", detail: "Finding the best public-transport route." });

    const timer = setTimeout(() => {
      if (gen === reachGen) {
        // Invalidate this generation BEFORE aborting: a res.json() that resolved
        // just before the abort could otherwise still pass the gen check and
        // draw/declutter after we gave up (panel-caught race).
        reachGen += 1;
        setView({ state: "error", title: "Couldn’t plan this trip", detail: "The routing service is slow — please try again." });
      }
      controller.abort();
    }, REACH_TIMEOUT_MS);

    fetch(req.url, { signal: controller.signal })
      .then(async (res) => {
        if (gen !== reachGen) return;
        if (res.status === 422) {
          return void setView({ state: "outside", title: "Outside the area", detail: "That point is outside the Bucharest area we cover." });
        }
        if (!res.ok) {
          return void setView({ state: "error", title: "Couldn’t plan this trip", detail: "Please try again in a moment." });
        }
        const plan = (await res.json()) as ReachPlan;
        if (gen !== reachGen) return;
        if (!plan.reachable) {
          return void setView({ state: "none", title: "No public-transport route", detail: "No trip was found for this departure time." });
        }
        // A plan with no transit leg is a walk-only (or bike-direct) fallback —
        // task 060: the owner rejected the walk/car band answers as useless, so a
        // right-click that yields no public-transport leg is reported as "no
        // public-transport route" (same as an unreachable result), NOT an "On
        // foot" walk-band. No draw, no declutter. The prior draw was torn down by
        // the arbiter above.
        if (!hasTransitLeg(plan.legs)) {
          return void setView({
            state: "none",
            title: "No public-transport route",
            detail: "No public-transport trip was found for this point.",
          });
        }
        const steps = buildReachSteps(plan.legs).map((s, i) => ({ ...s, mode: plan.legs[i].mode }));
        // A real public-transport journey: DRAW it and, only if it produced
        // drawable features, declutter + frame so the trip is legible beside the
        // dock (a transit plan with no drawable coords must not hide markers
        // behind an empty map — review).
        const drawn = journey.draw(plan.legs);
        if (drawn) {
          reachDeclutter.set(true);
          journey.frame(applyCameraPadding(true));
        }
        const withinBand = plan.totalMinutes <= band;
        setView({
          state: "transit",
          title: "By public transport",
          detail: withinBand
            ? `Within your ~${band}-min reach — journey ${reachSummary(plan)}.`
            : `Journey ${reachSummary(plan)} — a little beyond your ~${band}-min reach.`,
          steps,
        });
      })
      .catch((err) => {
        if ((err as Error)?.name === "AbortError" || gen !== reachGen) return;
        setView({ state: "error", title: "Couldn’t plan this trip", detail: "Please try again in a moment." });
      })
      .finally(() => clearTimeout(timer));
  }

  return {
    open,
    close,
    /** True when directions are currently shown (the result dock is a
     * ReachPanel). AppMap reads this to arbitrate the result-sheet content. */
    isActive: () => view !== null,
    /** Step hover/focus → highlight that leg + its stops on the map. */
    highlight: (index: number | null) => journey.highlight(index),
    /** Reframe the drawn journey (resize/orientation) — no-op if none drawn. */
    reframe: () => journey.frame(applyCameraPadding(true), true),
    subscribe(cb: (v: ReachView | null) => void) {
      subscriber = cb;
      cb(view);
    },
    dispose() {
      reachAbort?.abort();
      reachGen += 1;
      subscriber = null;
      // Do NOT teardown the journey here — the journey controller is disposed
      // separately (reverse-create order); calling clear() after its dispose is
      // harmless but redundant. Just detach the subscriber + cancel the fetch.
    },
  };
}

export type ReachDirectionsController = ReturnType<typeof createReachDirectionsController>;
