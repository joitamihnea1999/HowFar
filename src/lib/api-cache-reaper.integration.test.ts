import { randomUUID } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  __resetApiCacheL1ForTests,
  deleteExpired,
  getCached,
  setCached,
} from "@/lib/api-cache";
import { db } from "@/lib/db";

// Real-DB test: the reaper's whole point is a race that only exists against a real
// PostgreSQL. Opt in with `npm run test:db`-style POSTGIS_INTEGRATION=1.
const describePostgres = process.env.POSTGIS_INTEGRATION === "1" ? describe : describe.skip;

describePostgres("ApiCache reaper (deleteExpired)", () => {
  const suffix = randomUUID();
  const key = (name: string) => `reaper-test-${suffix}-${name}`;
  const past = new Date(Date.now() - 60_000);
  const future = new Date(Date.now() + 60 * 60_000);

  beforeEach(() => __resetApiCacheL1ForTests());

  afterAll(async () => {
    await db().apiCache.deleteMany({ where: { cacheKey: { startsWith: `reaper-test-${suffix}-` } } });
    await db().$disconnect();
  });

  it("deletes only expired rows and leaves a still-valid row untouched", async () => {
    await setCached(key("expired"), { v: 1 }, past);
    await setCached(key("valid"), { v: 2 }, future);

    await deleteExpired();
    __resetApiCacheL1ForTests(); // read DB truth, not an L1 hit

    expect(await getCached(key("expired"))).toBeNull();
    expect(await getCached<{ v: number }>(key("valid"))).toEqual({ v: 2 });
  });

  it("refresh-vs-sweep: a row refreshed to a future expiry SURVIVES the sweep", async () => {
    // The predicate lives INSIDE the DELETE, so a row that was expired but has since
    // been refreshed (setCached upserts a future expiresAt in place) is re-checked
    // at delete time and NOT removed.
    await setCached(key("refreshed"), { v: 1 }, past); // starts expired
    await setCached(key("refreshed"), { v: 2 }, future); // refreshed in place

    await deleteExpired();
    __resetApiCacheL1ForTests();

    expect(await getCached<{ v: number }>(key("refreshed"))).toEqual({ v: 2 });
  });

  it("is idempotent: a second sweep removes nothing more of our keys", async () => {
    await setCached(key("idem"), { v: 1 }, past);
    await deleteExpired();
    __resetApiCacheL1ForTests();
    expect(await getCached(key("idem"))).toBeNull();
    // Second sweep must not throw and must leave the still-valid key intact.
    await setCached(key("idem-valid"), { v: 9 }, future);
    await deleteExpired();
    __resetApiCacheL1ForTests();
    expect(await getCached<{ v: number }>(key("idem-valid"))).toEqual({ v: 9 });
  });

  it("concurrent refresh + sweep leaves the row present (upsert re-creates either ordering)", async () => {
    // Whichever wins: sweep-then-refresh (delete then upsert re-creates future) OR
    // refresh-then-sweep (future row re-checked, skipped) — both end with the row
    // present at a future expiry. A select-then-delete-by-id reaper could instead
    // delete the just-refreshed row.
    await setCached(key("race"), { v: 1 }, past);
    await Promise.all([deleteExpired(), setCached(key("race"), { v: 2 }, future)]);
    __resetApiCacheL1ForTests();
    expect(await getCached<{ v: number }>(key("race"))).toEqual({ v: 2 });
  });

  it("bounded batches still delete all expired rows", async () => {
    for (let i = 0; i < 5; i++) await setCached(key(`batch-${i}`), { i }, past);
    const { deleted } = await deleteExpired({ batchSize: 2 });
    expect(deleted).toBeGreaterThanOrEqual(5); // our 5 (plus any other expired rows)
    __resetApiCacheL1ForTests();
    for (let i = 0; i < 5; i++) expect(await getCached(key(`batch-${i}`))).toBeNull();
  });
});
