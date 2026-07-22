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

/** Retries the route-path stamp until the source is actually queryable. */
export const MAX_ROUTE_STAMP_ATTEMPTS = 12;

/**
 * What the route-path stamp loop should do on the current `idle` tick:
 * `stamp` once the source holds features, else `retry` while attempts remain,
 * else `stop`. A single `once("idle")` is not enough after permanent
 * `setPadding` + `easeTo` — idle can fire before the source is queryable,
 * leaving `data-route-path` unset while `data-route-framed` is already true
 * (the stop-lines selection-clear CI flake).
 */
export function nextStampAction(
  hasFeatures: boolean,
  attempts: number,
  maxAttempts: number = MAX_ROUTE_STAMP_ATTEMPTS,
): "stamp" | "retry" | "stop" {
  if (hasFeatures) return "stamp";
  return attempts < maxAttempts ? "retry" : "stop";
}
