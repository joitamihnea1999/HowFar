import { Suspense } from "react";

import AppMap from "@/components/AppMap";
import AuthControl from "@/components/AuthControl";

export default function Home() {
  return (
    <main className="relative h-dvh w-full overflow-hidden bg-zinc-950 text-zinc-50">
      <AppMap />
      {/* Session lookup hits the DB; Suspense lets the hero + map stream first
          even when the database is cold or paused (never block the first paint). */}
      <div className="pointer-events-none absolute right-0 top-0 z-20 flex justify-end p-4">
        <Suspense fallback={null}>
          <AuthControl />
        </Suspense>
      </div>
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex flex-col items-center gap-2 px-4 pt-12 text-center">
        <h1 className="text-4xl font-semibold tracking-tight drop-shadow-[0_2px_12px_rgba(0,0,0,0.8)] sm:text-5xl">
          HowFar
        </h1>
        <p className="max-w-md text-base text-zinc-300 drop-shadow-[0_1px_8px_rgba(0,0,0,0.9)] sm:text-lg">
          How good is it to live here? Paste an address and see — reach, amenities, air.
        </p>
        <p className="text-xs text-zinc-500">Bucharest · address search and isochrones land next</p>
      </div>
    </main>
  );
}
