/**
 * Mobile shell state — which chrome is on screen around the map.
 *
 * Below the `md` breakpoint the command dock and the result sheet together
 * covered most of the viewport (~31% of a 390×664 screen was unobstructed
 * map), so both surfaces gain a compact state: the dock collapses to a
 * one-line state pill once a selection resolves, and the result sheet opens
 * at a "peek" header until expanded. Desktop keeps today's always-expanded
 * layout — `deriveShell` is the single decision point, consumed by rendering
 * AND by `cameraPadding`, so the framed map area always matches the chrome
 * actually on screen.
 */

export type DockState = "expanded" | "collapsed";
export type SheetState = "peek" | "expanded";

export interface ShellState {
  dock: DockState;
  sheet: SheetState;
}

export interface ShellInputs {
  /** Viewport is below the `md` breakpoint (the mobile stacked layout). */
  isMobile: boolean;
  /** Selection status straight from the reducer. */
  selStatus: "idle" | "loading" | "error";
  /** A resolved origin exists (`sel.lastSelection !== null`). */
  hasSelection: boolean;
  /** User re-opened the dock from the pill; sticky until the next resolution. */
  userDockOpen: boolean;
  /** User expanded the sheet from the peek bar; sticky per selection. */
  userSheetExpanded: boolean;
  /** Right-click/long-press directions are showing in the result sheet. */
  reachActive: boolean;
}

export const EXPANDED_SHELL: ShellState = { dock: "expanded", sheet: "expanded" };

/**
 * Derivation rules (task 062):
 * - Desktop: always expanded/expanded — zero behavior change at `md+`.
 * - Dock collapses only when a selection HAS resolved (`hasSelection` — the
 *   pill can never render blank; `start` may clear the label but preserves
 *   `lastSelection` on recomputes) and the flow is not in `error` (errors
 *   reopen the dock so the message and inputs are in reach). A recompute from
 *   a collapsed state (e.g. right-click auto-switch to transit) stays
 *   collapsed: the pill derives from live state, so it never shows a stale
 *   mode.
 * - Sheet peeks by default; the user can expand it, and active directions
 *   FORCE it expanded (a journey answer must never hide behind a peek bar).
 *   An error forces it expanded too: the SelectionCard inside is the only
 *   surface that renders the failure message, and a peek bar reading
 *   "Result" over a hidden alert is a silent failure (found in review).
 */
export function deriveShell(i: ShellInputs): ShellState {
  if (!i.isMobile) return EXPANDED_SHELL;
  const dock: DockState =
    i.hasSelection && i.selStatus !== "error" && !i.userDockOpen ? "collapsed" : "expanded";
  const sheet: SheetState =
    i.reachActive || i.userSheetExpanded || i.selStatus === "error" ? "expanded" : "peek";
  return { dock, sheet };
}
