/**
 * Pure decision for what the sign-in affordance should show, split out from the
 * `AuthControl` server component so the three branches are unit-testable without
 * a DOM/RSC render harness. `AuthControl` supplies the session user and the
 * configured providers; this picks the mode and the display label.
 */

export type Provider = "google" | "github";

export type AuthView =
  | { mode: "signed-in"; label: string }
  | { mode: "sign-in"; providers: Provider[] }
  | { mode: "unavailable" };

type SessionUser = { name?: string | null; email?: string | null } | null | undefined;

export function resolveAuthView(user: SessionUser, providers: Provider[]): AuthView {
  if (user) {
    const label = user.name?.trim() || user.email?.trim() || "Account";
    return { mode: "signed-in", label };
  }
  if (providers.length === 0) return { mode: "unavailable" };
  return { mode: "sign-in", providers };
}
