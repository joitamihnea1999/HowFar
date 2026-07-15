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
 * `<T>` is caller-trust — the stored JSON is returned unchecked. M2 opts into a
 * runtime parser at the seams consuming real provider payloads (see
 * [[m2-cache-validation]]). The caller also owns the timeout boundary: wrap the
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
 * `value` must be JSON-serialisable (it lands in a MySQL `JSON` column).
 */
export async function setCached(
  key: string,
  value: Prisma.InputJsonValue,
  expiresAt: Date,
): Promise<void> {
  await db().apiCache.upsert({
    where: { cacheKey: key },
    create: { cacheKey: key, value, expiresAt },
    update: { value, expiresAt },
  });
}
