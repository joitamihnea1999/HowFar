import { optionalEnv, type EnvSource } from "@/lib/env";

/**
 * Which social providers have a full credential pair configured. Used by the
 * sign-in affordance; auth.ts's buildConfig registers the same pairs, and both
 * go through optionalEnv so "advertised" and "registered" can never disagree
 * (a whitespace-only var counts as absent in both). Lives outside auth.ts so
 * it can be unit-tested without importing the next-auth stack.
 */
export function configuredProviders(source: EnvSource = process.env): Array<"google" | "github"> {
  const list: Array<"google" | "github"> = [];
  if (optionalEnv(source, "AUTH_GOOGLE_ID") && optionalEnv(source, "AUTH_GOOGLE_SECRET")) {
    list.push("google");
  }
  if (optionalEnv(source, "AUTH_GITHUB_ID") && optionalEnv(source, "AUTH_GITHUB_SECRET")) {
    list.push("github");
  }
  return list;
}
