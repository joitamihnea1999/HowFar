import type { Session } from "next-auth";

import { auth, configuredProviders, signIn, signOut } from "@/auth";
import { resolveAuthView, type Provider } from "@/lib/auth-view";

const PROVIDER_LABEL: Record<Provider, string> = {
  google: "Google",
  github: "GitHub",
};

const PILL =
  "pointer-events-auto rounded-full border border-white/15 bg-black/40 px-4 py-1.5 text-sm " +
  "font-medium text-zinc-100 backdrop-blur transition-colors hover:bg-black/60 hover:border-white/25 " +
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-300";

/**
 * Session-aware sign-in affordance for the landing overlay. Async server
 * component: reads the session via `auth()` and renders one of three states
 * (signed-in / sign-in / unavailable) chosen by the pure `resolveAuthView`.
 * The sign-in/out actions are inline server actions wrapping Auth.js's
 * `signIn`/`signOut`.
 */
export default async function AuthControl() {
  // Degrade to signed-out on any auth/DB failure rather than throwing: the
  // landing hero + map must render even if the database is cold or unreachable.
  // (Suspense handles the pending await; it does NOT catch a rejection.)
  let session: Session | null = null;
  try {
    session = await auth();
  } catch {
    session = null;
  }
  const view = resolveAuthView(session?.user, configuredProviders());

  if (view.mode === "signed-in") {
    return (
      <div className="flex items-center gap-3">
        <span className="text-sm text-zinc-300 drop-shadow-[0_1px_6px_rgba(0,0,0,0.9)]">
          {view.label}
        </span>
        <form
          action={async () => {
            "use server";
            await signOut({ redirectTo: "/" });
          }}
        >
          <button type="submit" className={PILL}>
            Sign out
          </button>
        </form>
      </div>
    );
  }

  if (view.mode === "unavailable") {
    return (
      <span className="pointer-events-none text-xs text-zinc-500 drop-shadow-[0_1px_6px_rgba(0,0,0,0.9)]">
        Sign-in unavailable
      </span>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {view.providers.map((provider) => (
        <form
          key={provider}
          action={async () => {
            "use server";
            await signIn(provider, { redirectTo: "/" });
          }}
        >
          <button type="submit" className={PILL}>
            Sign in with {PROVIDER_LABEL[provider]}
          </button>
        </form>
      ))}
    </div>
  );
}
