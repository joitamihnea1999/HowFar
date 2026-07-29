import { useEffect, useState } from "react";

import { reachExplainer, type RingFilter } from "@/features/isochrones/isochrone-view";
import type { Mode } from "@/features/map/selection-flow";

/**
 * Mobile-only, dismissible one-liner explaining what the shaded reach areas
 * MEAN. The SelectionCard carries the same sentence, but the mobile shell
 * (task 062) collapses to a one-line peek bar once a selection resolves — so a
 * first-time mobile user, the exact audience that doesn't yet know what the
 * teal/violet/blue areas are, would never see it. This floats over the map just
 * above the sheet: the 44px peek-bar geometry and the camera padding stay
 * untouched, and the corners stay free for the zoom controls and attribution.
 * Dismissal is persisted under a versioned key; the copy itself stays live
 * (mode/ring changes update the sentence until the user dismisses it).
 */

export const RING_HINT_DISMISSED_KEY = "hf:ring-hint-dismissed:v1";

interface RingHintProps {
  mode: Mode;
  ringFilter: RingFilter;
  /** The surface condition: mobile shell + peek sheet + resolved selection +
   * no directions open. Evaluated by AppMap, which owns the shell state. */
  active: boolean;
}

export default function RingHint({ mode, ringFilter, active }: RingHintProps) {
  // Read the persisted dismissal AFTER mount: SSR has no localStorage, and
  // reading it lazily during render would hydration-mismatch a dismissed user.
  // `null` = not yet known → render nothing (no flash for returning users).
  // The rAF hop keeps the state write out of the effect body (AppMap's
  // established pattern for its amenity-preference read).
  const [dismissed, setDismissed] = useState<boolean | null>(null);
  useEffect(() => {
    let stored = false;
    try {
      stored = window.localStorage.getItem(RING_HINT_DISMISSED_KEY) === "1";
    } catch {
      // Storage may be unavailable in privacy-restricted browsing contexts —
      // show the hint; dismissal is then session-only.
    }
    const frame = window.requestAnimationFrame(() => setDismissed(stored));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  if (!active || dismissed !== false) return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      window.localStorage.setItem(RING_HINT_DISMISSED_KEY, "1");
    } catch {
      // Storage unavailable — the dismissal simply doesn't survive a reload.
    }
  };

  return (
    <div
      data-testid="ring-hint"
      role="status"
      className="pointer-events-auto absolute inset-x-10 bottom-[calc(var(--hf-sheet-clearance,0px)+0.5rem)] z-20 mx-auto flex max-w-[26rem] items-center gap-1 rounded-xl border border-white/[.1] bg-[#0d110e]/92 py-1 pl-3 pr-1 shadow-[0_10px_30px_rgba(0,0,0,.35)] backdrop-blur-xl md:hidden"
    >
      <p className="min-w-0 flex-1 text-[0.68rem] leading-4 text-[#c9d3cc]">{reachExplainer(mode, ringFilter)}</p>
      <button
        type="button"
        aria-label="Dismiss explanation"
        onClick={dismiss}
        className="grid size-11 shrink-0 place-items-center rounded-lg text-[#9ca9a0] transition-colors hover:bg-white/[.06] hover:text-[#edf2ed]"
      >
        <svg viewBox="0 0 20 20" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <path d="m6 6 8 8M14 6l-8 8" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
