import { createHash } from "node:crypto";

/**
 * Shared upstream-fetch plumbing for the server-side provider clients
 * (Nominatim, ORS, and later Overpass/Open-Meteo). Two jobs:
 *   1. A per-host serialized rate limiter — Nominatim's ToS mandates ≤1 req/s,
 *      and caching alone doesn't bound *distinct* cold requests.
 *   2. A real request timeout via AbortController — a stalled upstream is
 *      actually cancelled, not just raced (so it stops burning quota/sockets).
 *
 * Server-only: never import this from a `"use client"` module.
 */

/** Identifies the app to providers that require a UA (Nominatim, Overpass). */
export const USER_AGENT = "HowFar/1.0 (+https://howfar-production-b31c.up.railway.app)";

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

// One promise chain per host: calls run one-at-a-time, spaced ≥ minIntervalMs
// apart. A rejected call doesn't break the chain (we swallow to keep it moving).
const hostChain = new Map<string, Promise<unknown>>();
const hostLastStart = new Map<string, number>();

export function withRateLimit<T>(host: string, minIntervalMs: number, fn: () => Promise<T>): Promise<T> {
  const prev = hostChain.get(host) ?? Promise.resolve();
  const run = prev.then(async () => {
    const last = hostLastStart.get(host) ?? 0;
    const wait = last + minIntervalMs - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    hostLastStart.set(host, Date.now());
    return fn();
  });
  // Keep the chain alive regardless of this call's outcome.
  hostChain.set(
    host,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

/** fetch() with a hard timeout that aborts the underlying request. */
export async function timedFetch(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export interface ProviderFetchOptions {
  /** Rate-limit bucket key (usually the hostname). */
  rateHost: string;
  /** Minimum ms between upstream calls to this host. */
  minIntervalMs: number;
  /** Abort the request after this many ms. */
  timeoutMs: number;
  init?: RequestInit;
}

/** Rate-limited + timeout-bounded fetch for provider calls. */
export function providerFetch(url: string, opts: ProviderFetchOptions): Promise<Response> {
  return withRateLimit(opts.rateHost, opts.minIntervalMs, () =>
    timedFetch(url, opts.init ?? {}, opts.timeoutMs),
  );
}
