import { PrismaAdapter } from "@auth/prisma-adapter";
import NextAuth, { type NextAuthConfig, type NextAuthResult } from "next-auth";
import GitHub from "next-auth/providers/github";
import Google from "next-auth/providers/google";

import { configuredProviders } from "@/features/auth/server/auth-config";
import { db } from "@/lib/db";
import { serverEnv } from "@/lib/env";

// Re-exported so consumers keep one auth entry point; the implementation
// lives in features/auth/auth-config.ts where it is unit-testable without next-auth.
export { configuredProviders };

/**
 * Lazy config: NextAuth invokes this per request, never at `next build`,
 * so missing DATABASE_URL/AUTH_SECRET can't break the build (they are
 * validated by serverEnv() on first real request instead).
 */
function buildConfig(): NextAuthConfig {
  const env = serverEnv();
  const providers = [];
  // Driven by the same decision the sign-in UI uses, so "advertised" and
  // "registered" cannot drift; the pair-completeness check guarantees the
  // credential values below are present.
  for (const provider of configuredProviders()) {
    if (provider === "google") {
      providers.push(Google({ clientId: env.googleClientId!, clientSecret: env.googleClientSecret! }));
    } else {
      providers.push(GitHub({ clientId: env.githubClientId!, clientSecret: env.githubClientSecret! }));
    }
  }
  return {
    adapter: PrismaAdapter(db()),
    providers,
    secret: env.authSecret,
    // Railway terminates TLS at its proxy; the app must trust X-Forwarded-Host.
    trustHost: true,
  };
}

const nextAuth = NextAuth(() => buildConfig());

export const handlers: NextAuthResult["handlers"] = nextAuth.handlers;
export const auth: NextAuthResult["auth"] = nextAuth.auth;
export const signIn: NextAuthResult["signIn"] = nextAuth.signIn;
export const signOut: NextAuthResult["signOut"] = nextAuth.signOut;
