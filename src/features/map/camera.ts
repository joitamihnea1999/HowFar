/**
 * Shared responsive camera-inset contract. Every camera movement that frames a
 * subject must account for the same visible UI footprint: a left command rail
 * on desktop, or the top command surface and bounded result sheet on mobile.
 */

/** Tailwind `md` breakpoint — the desktop command rail activates here. */
export const DOCK_BREAKPOINT_PX = 768;

/** 16px page edge + 388px rail + 16px map breathing room. */
export const DOCK_CAMERA_PAD_LEFT_PX = 420;
export const SHORT_LANDSCAPE_MAX_HEIGHT_PX = 520;
export const SHORT_LANDSCAPE_CAMERA_PAD_TOP_PX = 168;
export const SHORT_LANDSCAPE_CAMERA_PAD_BOTTOM_PX = 132;

export const SHORT_VIEWPORT_HEIGHT_PX = 700;
export const MOBILE_CAMERA_PAD_TOP_PX = 188;
export const MOBILE_CAMERA_PAD_BOTTOM_PX = 228;
export const MOBILE_SHORT_CAMERA_PAD_TOP_PX = 152;
export const MOBILE_SHORT_CAMERA_PAD_BOTTOM_PX = 168;

export interface CameraPadding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * Camera padding for the current shell geometry. `hasResults` controls the
 * mobile bottom inset: before a selection there is no result sheet, while a
 * resolved/error state reserves a bounded sheet footprint. Desktop always uses
 * the left-only rail model plus a small perimeter breathing room.
 */
export function cameraPadding(
  viewportWidthPx: number,
  viewportHeightPx: number,
  hasResults: boolean,
): CameraPadding {
  if (viewportWidthPx >= DOCK_BREAKPOINT_PX && viewportHeightPx <= SHORT_LANDSCAPE_MAX_HEIGHT_PX) {
    return {
      top: SHORT_LANDSCAPE_CAMERA_PAD_TOP_PX,
      right: 12,
      bottom: hasResults ? SHORT_LANDSCAPE_CAMERA_PAD_BOTTOM_PX : 48,
      left: 12,
    };
  }
  if (viewportWidthPx >= DOCK_BREAKPOINT_PX) {
    return { top: 24, right: 24, bottom: 24, left: DOCK_CAMERA_PAD_LEFT_PX };
  }

  const short = viewportHeightPx <= SHORT_VIEWPORT_HEIGHT_PX;
  return {
    top: short ? MOBILE_SHORT_CAMERA_PAD_TOP_PX : MOBILE_CAMERA_PAD_TOP_PX,
    right: 12,
    bottom: hasResults ? (short ? MOBILE_SHORT_CAMERA_PAD_BOTTOM_PX : MOBILE_CAMERA_PAD_BOTTOM_PX) : 64,
    left: 12,
  };
}
