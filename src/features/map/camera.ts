/**
 * Shared responsive camera-inset contract. Every camera movement that frames a
 * subject must account for the same visible UI footprint: a left command rail
 * on desktop, or the top command surface and bounded result sheet on mobile.
 */

import { EXPANDED_SHELL, type ShellState } from "@/features/map/shell-state";

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
/** Collapsed dock = header (~64px) + state pill (~48px at top-[4.7rem]) + breathing room. */
export const MOBILE_CAMERA_PAD_TOP_COLLAPSED_PX = 140;
/** Peek sheet = one-line bar (~62px) above the 2.8rem bottom offset + breathing room. */
export const MOBILE_CAMERA_PAD_BOTTOM_PEEK_PX = 124;

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
 *
 * `shell` (task 062) is the mobile dock/sheet state: a collapsed dock leaves
 * only the header + state pill up top, and a peek sheet only a one-line bar at
 * the bottom, so the framed map area grows to match. Desktop branches ignore
 * it (shell-state is always expanded/expanded at `md+`). Defaults to the
 * expanded shell so pre-062 callers and tests keep their exact insets.
 */
export function cameraPadding(
  viewportWidthPx: number,
  viewportHeightPx: number,
  hasResults: boolean,
  shell: ShellState = EXPANDED_SHELL,
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
  const expandedTop = short ? MOBILE_SHORT_CAMERA_PAD_TOP_PX : MOBILE_CAMERA_PAD_TOP_PX;
  const expandedBottom = short ? MOBILE_SHORT_CAMERA_PAD_BOTTOM_PX : MOBILE_CAMERA_PAD_BOTTOM_PX;
  return {
    top: shell.dock === "collapsed" ? Math.min(MOBILE_CAMERA_PAD_TOP_COLLAPSED_PX, expandedTop) : expandedTop,
    right: 12,
    bottom: hasResults
      ? shell.sheet === "peek"
        ? Math.min(MOBILE_CAMERA_PAD_BOTTOM_PEEK_PX, expandedBottom)
        : expandedBottom
      : 64,
    left: 12,
  };
}
