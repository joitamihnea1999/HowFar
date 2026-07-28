import { describe, expect, it } from "vitest";

import {
  cameraPadding,
  DOCK_BREAKPOINT_PX,
  DOCK_CAMERA_PAD_LEFT_PX,
  MOBILE_CAMERA_PAD_BOTTOM_PEEK_PX,
  MOBILE_CAMERA_PAD_BOTTOM_PX,
  MOBILE_CAMERA_PAD_TOP_COLLAPSED_PX,
  MOBILE_CAMERA_PAD_TOP_PX,
  MOBILE_SHORT_CAMERA_PAD_BOTTOM_PX,
  MOBILE_SHORT_CAMERA_PAD_TOP_PX,
  SHORT_LANDSCAPE_CAMERA_PAD_BOTTOM_PX,
  SHORT_LANDSCAPE_CAMERA_PAD_TOP_PX,
} from "./camera";

describe("cameraPadding", () => {
  it("reserves the desktop command rail at md+ widths", () => {
    expect(cameraPadding(DOCK_BREAKPOINT_PX, 720, true)).toEqual({
      top: 24,
      right: 24,
      bottom: 24,
      left: DOCK_CAMERA_PAD_LEFT_PX,
    });
    expect(cameraPadding(1280, 900, false).left).toBe(DOCK_CAMERA_PAD_LEFT_PX);
  });

  it("reserves both mobile command and result surfaces after selection", () => {
    expect(cameraPadding(390, 844, true)).toEqual({
      top: MOBILE_CAMERA_PAD_TOP_PX,
      right: 12,
      bottom: MOBILE_CAMERA_PAD_BOTTOM_PX,
      left: 12,
    });
  });

  it("uses compact mobile insets at short heights and no result-sheet inset while idle", () => {
    expect(cameraPadding(700, 600, true)).toEqual({
      top: MOBILE_SHORT_CAMERA_PAD_TOP_PX,
      right: 12,
      bottom: MOBILE_SHORT_CAMERA_PAD_BOTTOM_PX,
      left: 12,
    });
    expect(cameraPadding(390, 844, false).bottom).toBe(64);
  });

  it("uses the compact top/bottom corridor for touch-landscape dimensions", () => {
    expect(cameraPadding(844, 390, true)).toEqual({
      top: SHORT_LANDSCAPE_CAMERA_PAD_TOP_PX,
      right: 12,
      bottom: SHORT_LANDSCAPE_CAMERA_PAD_BOTTOM_PX,
      left: 12,
    });
    expect(cameraPadding(844, 390, false).bottom).toBe(48);
  });

  // Task 062: a collapsed dock / peeked sheet leaves far less chrome on screen,
  // so the framed map area must grow to match — otherwise the subject stays
  // squeezed into the old expanded-layout box (plan-panel finding).
  it("shrinks the mobile top inset when the dock is collapsed to the state pill", () => {
    expect(cameraPadding(390, 844, true, { dock: "collapsed", sheet: "expanded" })).toEqual({
      top: MOBILE_CAMERA_PAD_TOP_COLLAPSED_PX,
      right: 12,
      bottom: MOBILE_CAMERA_PAD_BOTTOM_PX,
      left: 12,
    });
  });

  it("shrinks the mobile bottom inset when the sheet is at peek", () => {
    expect(cameraPadding(390, 844, true, { dock: "collapsed", sheet: "peek" })).toEqual({
      top: MOBILE_CAMERA_PAD_TOP_COLLAPSED_PX,
      right: 12,
      bottom: MOBILE_CAMERA_PAD_BOTTOM_PEEK_PX,
      left: 12,
    });
  });

  it("never lets a compact shell inset exceed the expanded one (short viewports)", () => {
    const short = cameraPadding(390, 640, true, { dock: "collapsed", sheet: "peek" });
    expect(short.top).toBeLessThanOrEqual(MOBILE_SHORT_CAMERA_PAD_TOP_PX);
    expect(short.bottom).toBeLessThanOrEqual(MOBILE_SHORT_CAMERA_PAD_BOTTOM_PX);
  });

  it("ignores shell state on desktop — the rail model is unchanged", () => {
    expect(cameraPadding(1280, 900, true, { dock: "collapsed", sheet: "peek" })).toEqual(
      cameraPadding(1280, 900, true),
    );
  });

  it("keeps the no-results bottom inset regardless of sheet state", () => {
    expect(cameraPadding(390, 844, false, { dock: "collapsed", sheet: "peek" }).bottom).toBe(64);
  });
});
