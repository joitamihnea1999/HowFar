import { describe, expect, it } from "vitest";

import {
  computeRouteFraming,
  MAX_ROUTE_STAMP_ATTEMPTS,
  nextStampAction,
  routeFitBreathingRoom,
} from "./route-framing";

const NO_INSETS = { top: 0, right: 0, bottom: 0, left: 0 };

describe("routeFitBreathingRoom", () => {
  it("gives the preferred 40px/edge on a roomy canvas", () => {
    expect(routeFitBreathingRoom(NO_INSETS, 1280, 720)).toEqual({
      top: 40,
      bottom: 40,
      left: 40,
      right: 40,
    });
  });

  it("shrinks symmetrically as docks eat the available room", () => {
    // clientHeight 200, no dock: verticalRoom = 200-72 = 128 → /2 = 64 → capped 40.
    // clientHeight 150: verticalRoom = 78 → /2 = 39 (< 40, so uncapped).
    const room = routeFitBreathingRoom(NO_INSETS, 200, 150);
    expect(room.top).toBeCloseTo(39);
    expect(room.bottom).toBeCloseTo(39);
  });

  it("never returns negative room when docks exceed the canvas", () => {
    const dock = { top: 400, bottom: 400, left: 400, right: 400 };
    const room = routeFitBreathingRoom(dock, 390, 500);
    expect(room.top).toBe(0);
    expect(room.bottom).toBe(0);
    expect(room.left).toBe(0);
    expect(room.right).toBe(0);
  });

  it("subtracts the dock before computing room (390px viewport stays fittable)", () => {
    // left dock 420 wider than half of 390 → horizontalRoom clamps to 0, not negative.
    const room = routeFitBreathingRoom({ ...NO_INSETS, left: 420 }, 390, 844);
    expect(room.left).toBe(0);
    expect(room.right).toBe(0);
  });
});

describe("computeRouteFraming", () => {
  it("reports framed when the bounds sit inside the padded viewport", () => {
    const r = computeRouteFraming({ x: 100, y: 100 }, { x: 300, y: 300 }, NO_INSETS, 400, 400);
    expect(r.framed).toBe(true);
    expect(r.corridorHeight).toBe(400);
  });

  it("reports NOT framed when a corner escapes past the padding edge", () => {
    const pad = { top: 50, right: 50, bottom: 50, left: 50 };
    // maxX 395 > 400 - 50 + 2 = 352 → escapes the right padding.
    const r = computeRouteFraming({ x: 60, y: 60 }, { x: 395, y: 200 }, pad, 400, 400);
    expect(r.framed).toBe(false);
  });

  it("allows a 2px sub-pixel tolerance at every edge", () => {
    const pad = { top: 10, right: 10, bottom: 10, left: 10 };
    // left edge exactly padding.left - 2 = 8 is still framed.
    const r = computeRouteFraming({ x: 8, y: 8 }, { x: 390, y: 390 }, pad, 400, 400);
    expect(r.framed).toBe(true);
  });

  it("orders the frame read-back minX,maxX,minY,maxY then the four paddings", () => {
    const pad = { top: 3, right: 4, bottom: 5, left: 6 };
    const r = computeRouteFraming({ x: 30, y: 40 }, { x: 10, y: 20 }, pad, 100, 100);
    expect(r.frame).toBe("10.0,30.0,20.0,40.0,6.0,4.0,3.0,5.0");
  });

  it("corridor height rounds clientHeight minus vertical padding", () => {
    const r = computeRouteFraming({ x: 0, y: 0 }, { x: 1, y: 1 }, { top: 10.4, right: 0, bottom: 20.4, left: 0 }, 100, 300);
    expect(r.corridorHeight).toBe(Math.round(300 - 10.4 - 20.4));
  });
});

describe("nextStampAction", () => {
  it("stamps as soon as the source holds features", () => {
    expect(nextStampAction(true, 0)).toBe("stamp");
    expect(nextStampAction(true, 99)).toBe("stamp");
  });

  it("retries while attempts remain and the source is still empty", () => {
    expect(nextStampAction(false, 0)).toBe("retry");
    expect(nextStampAction(false, MAX_ROUTE_STAMP_ATTEMPTS - 1)).toBe("retry");
  });

  it("stops once the attempt budget is exhausted (no infinite idle loop)", () => {
    expect(nextStampAction(false, MAX_ROUTE_STAMP_ATTEMPTS)).toBe("stop");
    expect(nextStampAction(false, MAX_ROUTE_STAMP_ATTEMPTS + 5)).toBe("stop");
  });
});
