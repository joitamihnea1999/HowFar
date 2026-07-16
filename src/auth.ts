import { PrismaAdapter } from "@auth/prisma-adapter";
import NextAuth, { type NextAuthConfig, type NextAuthResult } from "next-auth";
import GitHub from "next-auth/providers/github";
import Google from "next-auth/providers/google";

import { db } from "@/lib/db";
import { serverEnv } from "@/lib/env";

// Re-exported so consumers keep one auth entry point; the implementation
// lives in lib/auth-config.ts where it is unit-testable without next-auth.
export { configuredProviders } from "@/lib/auth-config";

/**
 * Lazy config: NextAuth invokes this per request, never at `next build`,
 * so missing DATABASE_URL/AUTH_SECRET can't break the build (they are
 * validated by serverEnv() on first real request instead).
 */
function buildConfig(): NextAuthConfig {
  const env = serverEnv();
  const providers = [];
  if (env.googleClientId && env.googleClientSecret) {
    providers.push(Google({ clientId: env.googleClientId, clientSecret: env.googleClientSecret }));
  }
  if (env.githubClientId && env.githubClientSecret) {
    providers.push(GitHub({ clientId: env.githubClientId, clientSecret: env.githubClientSecret }));
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
