import { PrismaAdapter } from "@auth/prisma-adapter";
import NextAuth, { type NextAuthConfig, type NextAuthResult } from "next-auth";
import GitHub from "next-auth/providers/github";
import Google from "next-auth/providers/google";

import { db } from "@/lib/db";
import { optionalEnv, serverEnv } from "@/lib/env";

/**
 * Which social providers have a full credential pair configured. Used by the
 * sign-in affordance (M1). Build-time safe (no required-env validation), but
 * shares optionalEnv's trim semantics with buildConfig below so "advertised"
 * and "registered" can never disagree.
 */
export function configuredProviders(): Array<"google" | "github"> {
  const list: Array<"google" | "github"> = [];
  if (optionalEnv(process.env, "AUTH_GOOGLE_ID") && optionalEnv(process.env, "AUTH_GOOGLE_SECRET"))
    list.push("google");
  if (optionalEnv(process.env, "AUTH_GITHUB_ID") && optionalEnv(process.env, "AUTH_GITHUB_SECRET"))
    list.push("github");
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
