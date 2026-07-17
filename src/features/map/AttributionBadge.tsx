/**
 * Data attribution — Transitous ToS requires a visible link to its sources
 * (basemap © OSM is shown by the MapLibre attribution control).
 */

export default function AttributionBadge() {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center px-4 pb-9 sm:pb-7">
      <p className="pointer-events-auto rounded-full border border-white/10 bg-black/50 px-3 py-1 text-[11px] text-zinc-400 backdrop-blur">
        Transit data ©{" "}
        <a
          href="https://transitous.org/sources/"
          target="_blank"
          rel="noreferrer"
          className="text-violet-300 underline decoration-dotted underline-offset-2 hover:text-violet-200"
        >
          Transitous
        </a>
      </p>
    </div>
  );
}
