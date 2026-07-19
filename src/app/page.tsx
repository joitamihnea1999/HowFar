import { Suspense } from "react";

import AppMap from "@/features/map/AppMap";
import AuthControl from "@/features/auth/server/AuthControl";

export default function Home() {
  return (
    <main className="relative isolate h-dvh w-full overflow-hidden bg-[#080b09] text-[#f4f7f2]">
      <AppMap
        utilityHeader={
          /* The server-rendered header is slotted inside AppMap after its
             command/results surfaces but before the canvas. That keeps search
             first, places account actions before map controls in tab order,
             and still lets the async auth lookup stream independently. */
          <header className="pointer-events-none absolute inset-x-0 top-0 z-40 flex items-start justify-between gap-3 px-4 pb-2 pt-[max(0.8rem,env(safe-area-inset-top))] sm:gap-4 sm:px-5 sm:pt-[max(1rem,env(safe-area-inset-top))]">
            <div className="flex min-w-0 items-center gap-2.5 drop-shadow-[0_4px_18px_rgba(0,0,0,0.65)]">
              <span
                aria-hidden="true"
                className="grid size-10 shrink-0 place-items-center rounded-[0.9rem] border border-[#d8ff87]/25 bg-[#c7f36b] text-[#172008] shadow-[0_8px_24px_rgba(199,243,107,0.18)] sm:size-11"
              >
                <svg viewBox="0 0 24 24" className="size-5 sm:size-[1.35rem]" fill="none">
                  <circle cx="12" cy="12" r="2.25" fill="currentColor" />
                  <path d="M6.1 14.1a6.3 6.3 0 0 1 0-4.2M17.9 9.9a6.3 6.3 0 0 1 0 4.2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  <path d="M3.1 16.5a10.1 10.1 0 0 1 0-9M20.9 7.5a10.1 10.1 0 0 1 0 9" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" opacity=".7" />
                </svg>
              </span>
              <div className="min-w-0">
                <h1 className="text-[1.05rem] font-semibold leading-none tracking-[-0.035em] sm:text-xl">HowFar</h1>
                <p className="mt-1 hidden text-[0.7rem] font-medium tracking-wide text-[#9ca9a0] sm:block">
                  Bucharest livability map
                </p>
              </div>
            </div>
            {/* Session lookup hits the DB; the map must remain useful even when
                the database is cold or paused. */}
            <Suspense fallback={null}>
              <AuthControl />
            </Suspense>
          </header>
        }
      />
    </main>
  );
}
