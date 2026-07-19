import type { Session } from "next-auth";

import { auth, configuredProviders, signIn, signOut } from "@/auth";
import { resolveAuthView, type Provider } from "@/features/auth/auth-view";

const PROVIDER_LABEL: Record<Provider, string> = {
  google: "Google",
  github: "GitHub",
};

const PILL =
  "pointer-events-auto inline-flex min-h-11 items-center justify-center rounded-xl border border-white/[.13] " +
  "bg-[#0c100d]/90 px-3.5 text-xs font-semibold text-[#f4f7f2] shadow-[0_10px_28px_rgba(0,0,0,.28)] " +
  "backdrop-blur-xl transition-[background-color,border-color,transform] hover:-translate-y-px hover:border-white/25 " +
  "hover:bg-[#151b17] sm:px-4 sm:text-sm";

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
      <div className="pointer-events-auto flex items-center gap-2 rounded-2xl border border-white/[.1] bg-[#0c100d]/86 p-1 pl-3 shadow-[0_10px_28px_rgba(0,0,0,.28)] backdrop-blur-xl">
        <span className="hidden max-w-36 truncate text-xs font-medium text-[#b6c1b8] sm:block">
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
      <span className="pointer-events-none rounded-full border border-white/[.08] bg-[#0c100d]/70 px-3 py-2 text-[0.68rem] font-medium text-[#78857b] shadow-[0_8px_24px_rgba(0,0,0,.2)] backdrop-blur-lg sm:text-xs">
        Sign-in unavailable
      </span>
    );
  }

  if (view.providers.length > 1) {
    return (
      <details className="pointer-events-auto group relative">
        <summary className={`${PILL} cursor-pointer list-none gap-2 [&::-webkit-details-marker]:hidden`}>
          Sign in
          <svg
            aria-hidden="true"
            viewBox="0 0 16 16"
            className="size-3.5 transition-transform group-open:rotate-180"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
          >
            <path d="m4 6 4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </summary>
        <div className="absolute right-0 top-[calc(100%+.5rem)] w-48 rounded-2xl border border-white/[.13] bg-[#0c100d]/96 p-1.5 shadow-[0_18px_46px_rgba(0,0,0,.42)] backdrop-blur-2xl">
          <p className="px-2.5 pb-1.5 pt-1 text-[0.62rem] font-semibold uppercase tracking-[0.12em] text-[#78857b]">
            Continue with
          </p>
          {view.providers.map((provider) => (
            <form
              key={provider}
              action={async () => {
                "use server";
                await signIn(provider, { redirectTo: "/" });
              }}
            >
              <button
                type="submit"
                className="flex min-h-11 w-full items-center rounded-xl px-2.5 text-left text-xs font-semibold text-[#e8eee9] transition-colors hover:bg-white/[.07]"
              >
                {PROVIDER_LABEL[provider]}
              </button>
            </form>
          ))}
        </div>
      </details>
    );
  }

  return (
    <div className="pointer-events-auto flex items-center gap-2">
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
