import { Suspense } from "react";

import AppMap from "@/components/AppMap";
import AuthControl from "@/components/AuthControl";

export default function Home() {
  return (
    <main className="relative h-dvh w-full overflow-hidden bg-zinc-950 text-zinc-50">
      <AppMap />
      {/* Session lookup hits the DB; Suspense lets the hero + map stream first
          even when the database is cold or paused (never block the first paint). */}
      {/* Compact top bar: wordmark left, session control right. The primary
          interaction (address search) is the centered overlay inside AppMap. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-30 flex items-start justify-between p-4">
        <div className="drop-shadow-[0_2px_12px_rgba(0,0,0,0.85)]">
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">HowFar</h1>
          <p className="hidden text-xs text-zinc-400 sm:block">
            How good is it to live in Bucharest?
          </p>
        </div>
        <Suspense fallback={null}>
          <AuthControl />
        </Suspense>
      </div>
    </main>
  );
}
