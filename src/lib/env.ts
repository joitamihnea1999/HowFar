/**
 * Typed, validated access to server-side environment variables.
 *
 * Required vars are read lazily (at request time, not import/build time) so
 * `next build` succeeds on machines without a database or secrets.
 * Secrets must never be re-exported under NEXT_PUBLIC_*.
 */

export interface ServerEnv {
  /** PostgreSQL connection string, e.g. postgresql://user:pass@host:5432/db */
  databaseUrl: string;
  /** Auth.js JWT/session encryption secret — required at runtime, even without OAuth. */
  authSecret: string;
  /** OAuth client credentials — optional; sign-in is hidden when a pair is absent. */
  googleClientId?: string;
  googleClientSecret?: string;
  githubClientId?: string;
  githubClientSecret?: string;
  /** OpenRouteService key (server-side only) — optional until isochrone features land. */
  orsApiKey?: string;
}

export class EnvError extends Error {
  constructor(variable: string, hint: string) {
    super(`Missing or invalid environment variable ${variable}: ${hint}`);
    this.name = "EnvError";
  }
}

/**
 * Plain record instead of NodeJS.ProcessEnv: Next's typed-env augmentation
 * makes ProcessEnv strict (NODE_ENV required) depending on build state, which
 * would make callers/tests type-check differently before vs after a build.
 */
export type EnvSource = Record<string, string | undefined>;

function required(source: EnvSource, name: string, hint: string): string {
  const value = source[name]?.trim();
  if (!value) throw new EnvError(name, hint);
  return value;
}

/**
 * Exported so build-time-safe callers (e.g. configuredProviders) share the
 * exact same present/absent semantics as parseServerEnv — a whitespace-only
 * var must never count as configured in one place and absent in another.
 */
export function optionalEnv(source: EnvSource, name: string): string | undefined {
  const value = source[name]?.trim();
  return value ? value : undefined;
}

const optional = optionalEnv;

export function parseServerEnv(source: EnvSource = process.env): ServerEnv {
  const databaseUrl = required(
    source,
    "DATABASE_URL",
    'expected a PostgreSQL connection string like "postgresql://user:pass@host:5432/db"',
  );
  if (!/^postgres(?:ql)?:\/\//.test(databaseUrl)) {
    throw new EnvError(
      "DATABASE_URL",
      `must start with postgresql:// or postgres:// (got "${databaseUrl.slice(0, 12)}…")`,
    );
  }
  return {
    databaseUrl,
    authSecret: required(
      source,
      "AUTH_SECRET",
      "generate one with `npx auth secret` or `openssl rand -base64 32`",
    ),
    googleClientId: optional(source, "AUTH_GOOGLE_ID"),
    googleClientSecret: optional(source, "AUTH_GOOGLE_SECRET"),
    githubClientId: optional(source, "AUTH_GITHUB_ID"),
    githubClientSecret: optional(source, "AUTH_GITHUB_SECRET"),
    orsApiKey: optional(source, "ORS_API_KEY"),
  };
}

let cached: ServerEnv | undefined;

/** Lazy, memoized accessor — call inside handlers, never at module top level. */
export function serverEnv(): ServerEnv {
  cached ??= parseServerEnv();
  return cached;
}
