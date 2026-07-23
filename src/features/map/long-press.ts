/**
 * A pure touch long-press recognizer for the right-click reachability popup on
 * mobile (task 052 D / plan-panel P15). Desktop uses MapLibre's `contextmenu`
 * (which also fires on Android Chrome's long-press), but iOS Safari never emits
 * `contextmenu`, so touch devices need this: hold a single finger still for
 * `thresholdMs` → fire, treating it like a right-click. Movement beyond
 * `moveTolerancePx` (a pan/drag), a second finger (pinch/zoom), or an early lift
 * cancels it. After it fires, the follow-up `click` MapLibre synthesises on lift
 * must be suppressed so a long-press never also starts a new selection.
 *
 * Pure/DI: the timer is injectable so it can be driven deterministically in
 * tests; screen-space points keep it independent of MapLibre types.
 */

export interface ScreenPoint {
  x: number;
  y: number;
}
export interface LngLat {
  lng: number;
  lat: number;
}
export interface LongPressInfo {
  point: ScreenPoint;
  lngLat: LngLat;
}

export interface LongPressOptions {
  onLongPress: (info: LongPressInfo) => void;
  thresholdMs?: number;
  moveTolerancePx?: number;
  setTimer?: (fn: () => void, ms: number) => number;
  clearTimer?: (handle: number) => void;
}

export interface LongPressRecognizer {
  /** Begin tracking a single-finger press. `touches` > 1 cancels (multi-touch). */
  start(point: ScreenPoint, lngLat: LngLat, touches?: number): void;
  /** A finger moved — cancels if it drifts past the tolerance (a pan). */
  move(point: ScreenPoint): void;
  /** A finger lifted. Returns true if a long-press had fired (⇒ suppress the
   * synthetic click that follows). */
  end(): boolean;
  /** Hard cancel (dispose / gesture change). */
  cancel(): void;
}

export function createLongPress(opts: LongPressOptions): LongPressRecognizer {
  const thresholdMs = opts.thresholdMs ?? 500;
  const moveTolerancePx = opts.moveTolerancePx ?? 10;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms) as unknown as number);
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h));

  let timer: number | null = null;
  let startPoint: ScreenPoint | null = null;
  let fired = false;

  function clear() {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    startPoint = null;
  }

  return {
    start(point, lngLat, touches = 1) {
      clear();
      fired = false;
      if (touches > 1) return; // pinch/multi-touch is never a long-press
      startPoint = point;
      timer = setTimer(() => {
        timer = null;
        fired = true;
        opts.onLongPress({ point, lngLat });
      }, thresholdMs);
    },
    move(point) {
      if (!startPoint) return;
      if (Math.hypot(point.x - startPoint.x, point.y - startPoint.y) > moveTolerancePx) clear();
    },
    end() {
      const didFire = fired;
      clear();
      fired = false;
      return didFire;
    },
    cancel() {
      clear();
      fired = false;
    },
  };
}
