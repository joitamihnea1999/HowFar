/** First-run map guidance. Pointer-transparent by design: the secondary
 * “click the map” path must work through the affordance itself. */

export default function EmptyState() {
  return (
    <section
      data-testid="first-run"
      aria-label="Getting started"
      className="pointer-events-none hf-surface-in w-full rounded-[1.35rem] border border-white/[.1] bg-[#0d110e]/82 px-4 py-3.5 shadow-[0_18px_44px_rgba(0,0,0,.3)] backdrop-blur-xl md:px-5 md:py-4"
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-xl bg-[#c7f36b]/12 text-[#d8ff87] ring-1 ring-[#c7f36b]/20"
        >
          <svg viewBox="0 0 24 24" className="size-[1.15rem]" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M12 21s6-5.2 6-11a6 6 0 1 0-12 0c0 5.8 6 11 6 11Z" />
            <circle cx="12" cy="10" r="2.1" />
          </svg>
        </span>
        <div>
          <h2 className="text-sm font-semibold tracking-[-0.02em] text-[#f4f7f2]">Start with an address</h2>
          <p className="mt-1 text-xs leading-5 text-[#9ca9a0]">
            Search above to see what daily life can reach in 15, 30, or 45 minutes.
          </p>
          <p className="mt-2 flex items-center gap-1.5 text-[0.68rem] font-medium uppercase tracking-[0.1em] text-[#78857b]">
            <span className="inline-block h-px w-4 bg-[#78857b]/55" />
            or click anywhere on the map
          </p>
        </div>
      </div>
    </section>
  );
}
