import { createHash } from "node:crypto";

/**
 * Shared upstream-fetch plumbing for the server-side provider clients
 * (Nominatim, ORS, and later Overpass/Open-Meteo). Two jobs:
 *   1. A per-PROVIDER serialized rate limiter (bucket `provider@host`, task 009)
 *      — Nominatim's ToS mandates ≤1 req/s, and caching alone doesn't bound
 *      *distinct* cold requests. Keying on the provider (not the bare host) keeps
 *      providers behind one self-hosted domain from serializing together; the
 *      interval is config-driven and `0` bypasses the chain entirely.
 *   2. A real request timeout via AbortController — a stalled upstream is
 *      actually cancelled, not just raced (so it stops burning quota/sockets).
 *
 * Server-only: never import this from a `"use client"` module.
 */

/** Identifies the app to providers that require a UA (Nominatim, Overpass). */
export const USER_AGENT = "HowFar/1.0 (+https://github.com/joitamihnea1999/HowFar)";

/** Thrown when an upstream provider fails (bad status, timeout, malformed body). */
export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderError";
  }
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Stable ~1.1m-precision coordinate string for cache keys and provider origins. */
export function roundCoord(n: number): string {
  return n.toFixed(5);
}

// One promise chain per bucket: calls run one-at-a-time, spaced ≥ minIntervalMs
// apart. A rejected call doesn't break the chain (we swallow to keep it moving).
// The bucket key is `${provider}@${host}` (see providerFetch), so DIFFERENT
// providers behind ONE self-hosted domain do NOT serialize into a single chain
// (task 009) — before this, a 20 s MOTIS call head-of-line-blocked a 300 ms
// Photon autocomplete once both resolved to the same host. NOTE this fixes
// CROSS-provider blocking only: two calls in the SAME bucket (e.g. the two MOTIS
// callers, which deliberately share `transit@host` for one ToS budget) still
// serialize, and the wait is not abort-aware — a queued call keeps its slot even
// past a caller's own deadline (a pre-existing, accepted residual; interval `0`
// bypasses the chain for a self-host that wants none).
const hostChain = new Map<string, Promise<unknown>>();
const hostLastStart = new Map<string, number>();

export function withRateLimit<T>(bucket: string, minIntervalMs: number, fn: () => Promise<T>): Promise<T> {
  // ≤0 means "no throttle" (a self-host with no ToS limit): bypass the
  // serialize-chain entirely so concurrent callers run in parallel rather than
  // queuing behind each other. Default config never sets 0, so this is inert there.
  if (minIntervalMs <= 0) return fn();
  const prev = hostChain.get(bucket) ?? Promise.resolve();
  const run = prev.then(async () => {
    const last = hostLastStart.get(bucket) ?? 0;
    const wait = last + minIntervalMs - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    hostLastStart.set(bucket, Date.now());
    return fn();
  });
  // Keep the chain alive regardless of this call's outcome.
  hostChain.set(
    bucket,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

/** fetch() with a hard timeout that aborts the underlying request. An optional
 * `externalSignal` is merged in (via AbortSignal.any) so a caller racing several
 * hosts can cancel the losers the moment one wins. */
export async function timedFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = externalSignal
    ? AbortSignal.any([controller.signal, externalSignal])
    : controller.signal;
  try {
    return await fetch(url, { ...init, signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The five upstream providers, as a closed set of literals. The rate-limit
 * bucket is keyed `${provider}@${host}`, so this label — NOT the host — is what
 * keeps providers apart when they share a self-hosted domain. It is a union
 * (not a bare string) so a mistyped or copy-pasted label is a COMPILE error
 * rather than a silent bucket re-collapse that would pass tests green.
 * The two MOTIS callers (one-to-all + plan) both use `"transit"` on purpose so
 * they keep sharing one bucket, as they did when keyed on the shared host.
 */
export type ProviderId = "nominatim" | "photon" | "ors" | "transit" | "overpass";

export interface ProviderFetchOptions {
  /** Which provider this call belongs to — the first half of the bucket key. */
  provider: ProviderId;
  /** Host for the second half of the bucket key (usually `new URL(base).host`). */
  rateHost: string;
  /** Minimum ms between upstream calls to this provider bucket (0 = no throttle). */
  minIntervalMs: number;
  /** Abort the request after this many ms. */
  timeoutMs: number;
  /** Optional caller-owned signal (e.g. abort the losers of a multi-host race). */
  signal?: AbortSignal;
  init?: RequestInit;
}

/** Rate-limited + timeout-bounded fetch for provider calls. The bucket is
 *  `${provider}@${host}`: provider IDs are fixed literals (never derived from
 *  env), so the `@` delimiter can't be forged from a hostname. The host half is
 *  canonicalized (lowercased, trailing DNS dot stripped) so case/`host.`-variant
 *  spellings of ONE server collapse to ONE bucket instead of racing it in
 *  parallel at 2× the fair-use rate (task 009). */
export function providerFetch(url: string, opts: ProviderFetchOptions): Promise<Response> {
  const host = opts.rateHost.toLowerCase().replace(/\.$/, "");
  return withRateLimit(`${opts.provider}@${host}`, opts.minIntervalMs, () =>
    timedFetch(url, opts.init ?? {}, opts.timeoutMs, opts.signal),
  );
}
