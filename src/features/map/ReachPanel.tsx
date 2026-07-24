import { useEffect, useRef } from "react";

import type { ReachView } from "@/features/map/reach-directions-controller";

/**
 * The right-click "how do I get there?" directions, rendered in the RESULT-SHEET
 * DOCK instead of a map-covering popup (task 058, owner item 2). While it is
 * shown it REPLACES the SelectionCard + pace/time + amenity filters (which are
 * useless during a journey view — the owner's exact ask). Pure presentation of
 * the reach-directions controller's `ReachView`; step hover/focus drives the map
 * highlight via `onHighlight`, and "Back" / Escape closes via `onClose`.
 *
 * A11y (panel terra-5): the map container is a plain div, so focus can't just
 * "return to the map" implicitly. On open we move focus to the panel heading
 * (tabIndex -1 + ref); Escape and Back close and AppMap returns focus to the map
 * container. Steps are keyboard-operable (tabIndex 0, focus == hover). All text
 * is React text nodes — OSM stop names / line headsigns stay untrusted (same XSS
 * posture as the old popup, which used textContent).
 */

interface ReachPanelProps {
  view: ReachView;
  onHighlight: (index: number | null) => void;
  onClose: () => void;
}

// A compact glyph per leg mode for the step rail (mirrors the old popup). Plain
// unicode keeps it self-contained and legible at small size.
function stepGlyph(mode: string): string {
  switch (mode.toUpperCase()) {
    case "WALK":
      return "→";
    case "BUS":
    case "COACH":
      return "B";
    case "TRAM":
      return "T";
    case "SUBWAY":
    case "METRO":
      return "M";
    case "RAIL":
    case "REGIONAL_RAIL":
      return "R";
    case "TROLLEYBUS":
      return "Tb";
    case "FERRY":
      return "F";
    default:
      return "•";
  }
}

export default function ReachPanel({ view, onHighlight, onClose }: ReachPanelProps) {
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  // Move focus to the heading when the directions open (and whenever the view's
  // state changes to a new answer), so keyboard users land in the panel.
  useEffect(() => {
    headingRef.current?.focus();
  }, [view.state]);

  // Escape closes the directions from ANYWHERE (panel fable-1): after the user
  // pans/clicks the map, focus leaves the panel, so a panel-scoped handler would
  // go dead. Listen at document level while mounted — but skip when the event
  // originates in the search command surface, whose own Escape dismisses the
  // autocomplete (don't yank the directions out from under that).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if ((e.target as HTMLElement | null)?.closest?.('[data-testid="command-surface"]')) return;
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const isTransit = view.state === "transit" && Array.isArray(view.steps);

  return (
    <section
      data-testid="reach-panel"
      data-state={view.state}
      aria-label="Directions"
      className="rounded-[1.1rem] border border-white/[.08] bg-white/[.035] p-3.5 md:p-4"
    >
      <div className="flex items-start justify-between gap-3">
        {/* aria-live region: a second right-click of the same kind updates the
            title/detail without remounting the panel, so this makes AT announce
            the new answer (panel fable-2). */}
        <div aria-live="polite" aria-atomic="true" className="min-w-0">
          <p className="text-[0.62rem] font-semibold uppercase tracking-[0.16em] text-[#a78bfa]">How do I get there?</p>
          <h2
            ref={headingRef}
            tabIndex={-1}
            className="mt-1 text-sm font-semibold leading-5 text-[#f4f7f2] outline-none"
          >
            {view.title}
          </h2>
          {view.detail ? <p className="mt-2 text-xs leading-5 text-[#9ca9a0]">{view.detail}</p> : null}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-[0.65rem] border border-white/[.1] px-2.5 text-[0.7rem] font-semibold text-[#9ca9a0] transition-colors hover:bg-white/[.06] hover:text-[#edf2ed]"
        >
          ← Back to your area
        </button>
      </div>

      {view.state === "loading" ? (
        <div className="mt-3 flex items-center gap-3">
          <span className="hf-spinner size-5 shrink-0 rounded-full border-2 border-[#a78bfa]/25 border-t-[#a78bfa]" aria-hidden="true" />
          <span className="text-xs text-[#78857b]">Finding the best route…</span>
        </div>
      ) : null}

      {isTransit ? (
        <>
          <ol data-testid="reach-steps" className="mt-3 grid gap-1.5 border-t border-white/[.07] pt-3">
            {view.steps!.map((step, index) => {
              const isWalk = step.mode.toUpperCase() === "WALK";
              return (
                <li
                  key={index}
                  data-step-mode={isWalk ? "walk" : "transit"}
                  tabIndex={0}
                  onMouseEnter={() => onHighlight(index)}
                  onMouseLeave={() => onHighlight(null)}
                  onFocus={() => onHighlight(index)}
                  onBlur={() => onHighlight(null)}
                  className="flex items-start gap-2.5 rounded-lg px-1.5 py-1 outline-none transition-colors hover:bg-white/[.05] focus-visible:bg-white/[.06] focus-visible:ring-1 focus-visible:ring-[#a78bfa]/60"
                >
                  <span
                    aria-hidden="true"
                    className={`mt-0.5 grid size-6 shrink-0 place-items-center rounded-full text-[0.6rem] font-bold ${
                      isWalk
                        ? "bg-[#2dd4bf]/15 text-[#2dd4bf] ring-1 ring-[#2dd4bf]/30"
                        : "bg-[#a78bfa]/15 text-[#c4b5fd] ring-1 ring-[#a78bfa]/30"
                    }`}
                  >
                    {stepGlyph(step.mode)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs font-medium leading-4 text-[#edf2ed]">{step.primary}</span>
                    <span className="mt-0.5 block text-[0.68rem] leading-4 text-[#78857b]">{step.secondary}</span>
                  </span>
                </li>
              );
            })}
          </ol>
          <p className="mt-2.5 text-[0.62rem] leading-4 text-[#667269]">Routing via transitous.org</p>
        </>
      ) : null}
    </section>
  );
}
