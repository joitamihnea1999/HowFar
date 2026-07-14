import { PrismaAdapter } from "@auth/prisma-adapter";
import NextAuth, { type NextAuthConfig, type NextAuthResult } from "next-auth";
import GitHub from "next-auth/providers/github";
import Google from "next-auth/providers/google";

import { db } from "@/lib/db";
import { serverEnv } from "@/lib/env";

/**
 * Which social providers have a full credential pair configured.
 * Reads process.env directly (not serverEnv) so it is safe at build time
 * and usable from server components to hide the sign-in affordance.
 */
export function configuredProviders(): Array<"google" | "github"> {
  const list: Array<"google" | "github"> = [];
  if (process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET) list.push("google");
  if (process.env.AUTH_GITHUB_ID && process.env.AUTH_GITHUB_SECRET) list.push("github");
  return list;
}

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
