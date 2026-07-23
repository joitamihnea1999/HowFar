import { describe, expect, it, vi } from "vitest";

import { createLongPress, type LongPressInfo } from "@/features/map/long-press";

// Deterministic injectable timer: `flush()` runs pending callbacks whose delay
// has "elapsed"; we just fire them on demand.
function fakeTimer() {
  const pending = new Map<number, () => void>();
  let seq = 1;
  return {
    set: (fn: () => void) => {
      const id = seq++;
      pending.set(id, fn);
      return id;
    },
    clear: (id: number) => void pending.delete(id),
    fire: () => {
      for (const fn of pending.values()) fn();
      pending.clear();
    },
    size: () => pending.size,
  };
}

function make(onLongPress = vi.fn<(i: LongPressInfo) => void>()) {
  const t = fakeTimer();
  const r = createLongPress({ onLongPress, thresholdMs: 500, moveTolerancePx: 10, setTimer: t.set, clearTimer: t.clear });
  return { r, t, onLongPress };
}

const P = (x: number, y: number) => ({ x, y });
const LL = { lng: 26.1, lat: 44.4 };

describe("createLongPress", () => {
  it("fires after the hold when the finger stays still", () => {
    const { r, t, onLongPress } = make();
    r.start(P(100, 100), LL);
    t.fire();
    expect(onLongPress).toHaveBeenCalledWith({ point: { x: 100, y: 100 }, lngLat: LL });
    expect(r.end()).toBe(true); // fired ⇒ suppress the follow-up click
  });

  it("does NOT fire if the finger moves past tolerance (a pan)", () => {
    const { r, t, onLongPress } = make();
    r.start(P(100, 100), LL);
    r.move(P(100, 120)); // 20px > 10px tolerance
    t.fire();
    expect(onLongPress).not.toHaveBeenCalled();
    expect(t.size()).toBe(0); // timer was cleared
    expect(r.end()).toBe(false);
  });

  it("tolerates tiny jitter within tolerance", () => {
    const { r, t, onLongPress } = make();
    r.start(P(100, 100), LL);
    r.move(P(105, 103)); // ~5.8px < 10px
    t.fire();
    expect(onLongPress).toHaveBeenCalledOnce();
  });

  it("does NOT fire on an early lift (before the threshold)", () => {
    const { r, onLongPress } = make();
    r.start(P(100, 100), LL);
    expect(r.end()).toBe(false); // lifted before the timer fired
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("does NOT fire on multi-touch (pinch/zoom)", () => {
    const { r, t, onLongPress } = make();
    r.start(P(100, 100), LL, 2);
    t.fire();
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("cancel() stops a pending press", () => {
    const { r, t, onLongPress } = make();
    r.start(P(100, 100), LL);
    r.cancel();
    t.fire();
    expect(onLongPress).not.toHaveBeenCalled();
    expect(r.end()).toBe(false);
  });

  it("uses real timers + default threshold when none are injected", () => {
    vi.useFakeTimers();
    try {
      const onLongPress = vi.fn();
      const r = createLongPress({ onLongPress }); // no setTimer/clearTimer/thresholds
      r.start(P(1, 1), LL); // default touches=1
      vi.advanceTimersByTime(500); // default threshold
      expect(onLongPress).toHaveBeenCalledOnce();
      // cancel() must clear via the real clearTimeout (no second fire).
      r.start(P(1, 1), LL);
      r.cancel();
      vi.advanceTimersByTime(1000);
      expect(onLongPress).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("move() before any start is a no-op", () => {
    const { r, onLongPress } = make();
    r.move(P(50, 50)); // no active press
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("a fresh start after a fire resets the suppress flag", () => {
    const { r, t } = make();
    r.start(P(100, 100), LL);
    t.fire();
    expect(r.end()).toBe(true);
    // Next press that is lifted early must not still report 'fired'.
    r.start(P(100, 100), LL);
    expect(r.end()).toBe(false);
  });
});
