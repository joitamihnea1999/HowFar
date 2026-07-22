/**
 * Pure geometry/decision helpers for the drawn transit route path, split out of
 * `AppMap` so the pixel math and the stamp-retry rule are unit-tested without a
 * live MapLibre map. The controller keeps only the imperative parts —
 * `map.project`, `map.getPadding`, `easeTo`, `querySourceFeatures` — and feeds
 * their results through these functions.
 */

export interface EdgeInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface PixelPoint {
  x: number;
  y: number;
}

/**
 * Extra breathing room (beyond MapLibre's dock padding, which its bounds solver
 * already includes) so a fitted route keeps a real viewing corridor even when
 * the command + result docks eat most of the height. Capped at 40px/edge; never
 * negative. Passing the absolute dock values would double-count them and make a
 * 390px viewport mathematically impossible to fit.
 */
export function routeFitBreathingRoom(
  dock: EdgeInsets,
  clientWidth: number,
  clientHeight: number,
): EdgeInsets {
  const verticalRoom = Math.max(0, clientHeight - dock.top - dock.bottom - 72);
  const horizontalRoom = Math.max(0, clientWidth - dock.left - dock.right - 96);
  const verticalExtra = Math.min(40, verticalRoom / 2);
  const horizontalExtra = Math.min(40, horizontalRoom / 2);
  return {
    top: verticalExtra,
    bottom: verticalExtra,
    right: horizontalExtra,
    left: horizontalExtra,
  };
}

/**
 * Whether the projected route bounds sit inside the padded viewport, plus the
 * testable read-back attributes (`data-route-framed`, `-corridor-height`,
 * `-frame`). `a`/`b` are the projected corners; a 2px tolerance absorbs
 * sub-pixel rounding at the padding edges.
 */
export function computeRouteFraming(
  a: PixelPoint,
  b: PixelPoint,
  padding: EdgeInsets,
  clientWidth: number,
  clientHeight: number,
): { framed: boolean; corridorHeight: number; frame: string } {
  const minX = Math.min(a.x, b.x);
  const maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxY = Math.max(a.y, b.y);
  const framed =
    minX >= padding.left - 2 &&
    maxX <= clientWidth - padding.right + 2 &&
    minY >= padding.top - 2 &&
    maxY <= clientHeight - padding.bottom + 2;
  const corridorHeight = Math.round(clientHeight - padding.top - padding.bottom);
  const frame = [
    minX.toFixed(1),
    maxX.toFixed(1),
    minY.toFixed(1),
    maxY.toFixed(1),
    padding.left.toFixed(1),
    padding.right.toFixed(1),
    padding.top.toFixed(1),
    padding.bottom.toFixed(1),
  ].join(",");
  return { framed, corridorHeight, frame };
}

/** Wall-clock ceiling for the route-path stamp poll. Generous on purpose: the
 * stamp is an e2e-only sync hook, and the ceiling must exceed Playwright's 5s
 * expect-timeout so the poll never gives up before the assertion would. A
 * frame-count budget was refresh-rate/CI-jank dependent and could expire
 * mid-parse (the old flake). */
export const ROUTE_STAMP_DEADLINE_MS = 10_000;

/**
 * What the route-path stamp poll should do this tick: `stamp` once the source
 * actually holds queryable features, else `retry` until the wall-clock
 * deadline, else `stop`. The poll is driven by `requestAnimationFrame` (which
 * always advances) — NOT `map.once("idle")`, which after the permanent
 * `setPadding` + fit `easeTo` settles fires once and then never again,
 * stranding a retry that re-registered it and leaving `data-route-path` unset
 * (the recurring CI flake, tasks 029/047). Deadline (not a frame count) so the
 * give-up is wall-clock, independent of display refresh rate and CPU jitter.
 */
export function nextStampAction(
  hasFeatures: boolean,
  deadlineExceeded: boolean,
): "stamp" | "retry" | "stop" {
  if (hasFeatures) return "stamp";
  return deadlineExceeded ? "stop" : "retry";
}

/** Injectable deps for the route-path stamp poll — everything imperative the
 * controller supplies from the live map/clock/scheduler, so the poll's driver
 * semantics are unit-testable with fakes (the controller itself is e2e-only glue). */
export interface StampPollDeps {
  /** Are the drawn route features queryable in the source yet? */
  hasFeatures: () => boolean;
  /** Monotonic clock (`performance.now`). */
  now: () => number;
  /** Schedule the next poll tick (`requestAnimationFrame`) — MUST always advance,
   * unlike `map.once("idle")`, which never re-fires after the map settles. */
  schedule: (tick: () => void) => void;
  /** True once this draw is superseded (clear/replace/dispose bumped the gen) —
   * the poll then stops without stamping and without rescheduling. */
  cancelled: () => boolean;
  /** Write the `data-route-path` stamp. */
  onStamp: () => void;
  /** Wall-clock give-up ceiling (defaults to ROUTE_STAMP_DEADLINE_MS). */
  deadlineMs?: number;
}

/**
 * Poll until the route source holds queryable features, then stamp — retrying via
 * the injected `schedule` (rAF), giving up only past a wall-clock deadline. This
 * is the fix for the CI flake (tasks 029/047/048): the old retry re-registered
 * `map.once("idle")`, which never re-fires once the fit ease settles, stranding
 * the stamp. rAF always advances, so the poll can't strand.
 */
export function runRoutePathStampPoll(deps: StampPollDeps): void {
  const deadlineMs = deps.deadlineMs ?? ROUTE_STAMP_DEADLINE_MS;
  const start = deps.now();
  const tick = () => {
    if (deps.cancelled()) return;
    const action = nextStampAction(deps.hasFeatures(), deps.now() - start >= deadlineMs);
    if (action === "stamp") deps.onStamp();
    else if (action === "retry") deps.schedule(tick);
    // "stop" → give up silently (deadline hit with the source still empty)
  };
  deps.schedule(tick);
}
