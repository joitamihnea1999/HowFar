import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";

/**
 * Server-side cache for external provider responses (Nominatim/ORS/Overpass/
 * Open-Meteo) so the app stays inside free-tier quotas (brief §10). Backed by
 * the `ApiCache` table; `cacheKey` is the caller-chosen identity of a request.
 *
 * Consumers arrive in M2 — M1 ships the accessor + its tests only.
 */

/**
 * Read a cached response. A row is a HIT only while it has not expired
 * (`expiresAt > now`); exactly at or after `expiresAt` it is a miss.
 *
 * Expired rows are intentionally NOT deleted here: cleanup is a separate sweep
 * keyed on the `expiresAt` index. Keeping this a pure read avoids a race where
 * a concurrent `setCached` writes a fresh value between another caller's read
 * and delete, and that fresh value gets erased.
 *
 * `<T>` is caller-trust — the stored JSON is returned unchecked; provider
 * clients re-validate shape at their seams (the `normalize` functions in
 * providers/*.ts). The caller also owns the timeout boundary: wrap the
 * call in `withTimeout` if a stalled DB must not hang the request (this repo
 * has no driver-side query timeout by design).
 */
export async function getCached<T>(key: string, now: Date = new Date()): Promise<T | null> {
  const row = await db().apiCache.findUnique({ where: { cacheKey: key } });
  if (!row) return null;
  if (row.expiresAt <= now) return null;
  return row.value as unknown as T;
}

/**
 * Insert or replace a cached response under `key`, valid until `expiresAt`.
 * `value` is caller-trust (like getCached's `<T>`): it must be JSON-serialisable
 * — it lands in a MySQL `JSON` column — but the type is `unknown` so callers can
 * store normalized provider payloads (with loosely-typed nested geometry, etc.)
 * without fighting Prisma's strict InputJsonValue at every seam.
 */
export async function setCached(key: string, value: unknown, expiresAt: Date): Promise<void> {
  await db().apiCache.upsert({
    where: { cacheKey: key },
    create: { cacheKey: key, value: value as Prisma.InputJsonValue, expiresAt },
    update: { value: value as Prisma.InputJsonValue, expiresAt },
  });
}

/**
 * Best-effort cache accessors for the provider layer: the cache is an
 * optimisation, not a hard dependency, so a cache/DB failure must degrade to
 * "uncached" (the core map flow keeps working per brief §10) rather than fail
 * the request. Use these from provider clients; use the strict getCached/
 * setCached where a DB error genuinely should surface (e.g. saved searches).
 */

// Swallowed failures must stay observable — a dead cache silently forfeits the
// free-tier protection and slows every request. Warn at most once per interval
// so a database outage does not also flood the logs (2 lines per request).
const WARN_INTERVAL_MS = 60_000;
let lastWarnAt = -Infinity;

function warnCacheFailure(op: "read" | "write", err: unknown): void {
  const now = Date.now();
  if (now - lastWarnAt < WARN_INTERVAL_MS) return;
  lastWarnAt = now;
  const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  console.warn(`[api-cache] best-effort ${op} failed; serving uncached (${detail})`);
}

export async function getCachedSafe<T>(key: string, now: Date = new Date()): Promise<T | null> {
  try {
    return await getCached<T>(key, now);
  } catch (err) {
    warnCacheFailure("read", err);
    return null;
  }
}

export async function setCachedSafe(key: string, value: unknown, expiresAt: Date): Promise<void> {
  try {
    await setCached(key, value, expiresAt);
  } catch (err) {
    warnCacheFailure("write", err);
  }
}
