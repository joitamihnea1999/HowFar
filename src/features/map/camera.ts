/**
 * Shared camera-padding contract (task 024): on md+ viewports the control dock
 * floats over the map's left edge, so every camera movement that frames a
 * subject (the selection flyTo, a route-path fitBounds) must pad the left side
 * by the dock's footprint — one constant, one helper, used by ALL of them, or
 * subjects land underneath the dock.
 */

/** Tailwind `md` breakpoint — the dock (and its camera padding) activates here. */
export const DOCK_BREAKPOINT_PX = 768;

/** Dock footprint: 16px left margin + 350px column + 14px breathing room. */
export const DOCK_CAMERA_PAD_LEFT_PX = 380;

/** Camera padding for the current viewport width. Zero below `md`, where the
 * controls stack on top of the map instead of docking left. */
export function cameraPadding(viewportWidthPx: number): { left: number } {
  return { left: viewportWidthPx >= DOCK_BREAKPOINT_PX ? DOCK_CAMERA_PAD_LEFT_PX : 0 };
}
