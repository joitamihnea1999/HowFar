/**
 * Data attribution — Transitous ToS requires a visible link to its sources
 * (basemap © OSM is shown by the MapLibre attribution control).
 */

interface AttributionBadgeProps {
  /** Lift above the bounded mobile result sheet; desktop keeps bottom-center. */
  elevated: boolean;
}

export default function AttributionBadge({ elevated }: AttributionBadgeProps) {
  return (
    <div
      className={`hf-transit-attribution pointer-events-none absolute inset-x-0 z-20 flex justify-center px-4 transition-[bottom] duration-200 md:bottom-0 md:pb-7 ${
        elevated
          ? "bottom-[calc(min(30dvh,14.5rem)+3.25rem)] pb-0"
          : "bottom-0 pb-[max(2.25rem,calc(env(safe-area-inset-bottom)+1.8rem))]"
      }`}
    >
      <p className="pointer-events-auto rounded-full border border-white/[.09] bg-[#080b09]/82 px-2.5 py-1 text-[0.62rem] font-medium text-[#78857b] shadow-[0_8px_20px_rgba(0,0,0,.24)] backdrop-blur-xl">
        Transit ©{" "}
        <a
          href="https://transitous.org/sources/"
          target="_blank"
          rel="noreferrer"
          className="text-[#c4b5fd] underline decoration-dotted underline-offset-2 transition-colors hover:text-[#ddd6fe]"
        >
          Transitous
        </a>
      </p>
    </div>
  );
}
