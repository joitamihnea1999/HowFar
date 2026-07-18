import { AMENITY_CATEGORIES, type AmenityCounts } from "@/features/amenities/amenities";

/**
 * Nearby amenities within the 15-min walking isochrone (brief §5).
 * Mode-independent: shown for the selected address in both views. Pure
 * presentation — fetch/generation/abort live in AppMap; `counts` are the
 * server's TRUE clipped totals, not a recount of the capped markers.
 */

interface AmenityPanelProps {
  status: "idle" | "loading" | "ready" | "error";
  counts: AmenityCounts | null;
  /** Refetch the failed origin — shown as a Retry button in the error state. */
  onRetry: () => void;
}

export default function AmenityPanel({ status, counts, onRetry }: AmenityPanelProps) {
  if (status === "idle") return null;
  return (
    <div className="pointer-events-auto flex max-w-md flex-col items-center gap-1.5 rounded-2xl border border-white/10 bg-black/50 px-4 py-2.5 text-center backdrop-blur">
      <span className="text-xs font-medium text-zinc-300">Within a 15-min walk</span>
      {status === "loading" ? (
        <span className="text-xs text-zinc-500">Finding nearby amenities…</span>
      ) : status === "error" ? (
        <span className="flex items-center gap-2 text-xs text-amber-300">
          Amenities unavailable right now
          <button
            type="button"
            onClick={onRetry}
            className="rounded-full border border-amber-300/40 px-2.5 py-0.5 font-medium text-amber-200 transition-colors hover:border-amber-200 hover:text-amber-100"
          >
            Retry
          </button>
        </span>
      ) : counts ? (
        <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs">
          {AMENITY_CATEGORIES.map((c) => (
            <span key={c.key} className="flex items-center gap-1.5">
              <span
                className="inline-block h-2 w-2 rounded-full ring-1 ring-white/40"
                style={{ background: c.color }}
              />
              <span className="font-medium tabular-nums text-zinc-100">{counts[c.key]}</span>
              <span className="text-zinc-400">{c.label}</span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
