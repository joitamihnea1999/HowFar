import { describe, expect, it } from "vitest";

import {
  cameraPadding,
  DOCK_BREAKPOINT_PX,
  DOCK_CAMERA_PAD_LEFT_PX,
  MOBILE_CAMERA_PAD_BOTTOM_PX,
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
});
