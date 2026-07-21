import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetApiCacheL1ForTests,
  getCached,
  getCachedSafe,
  setCached,
  setCachedSafe,
} from "./api-cache";

// getCached/setCached compose db().apiCache with a time comparison. We back the
// mock with an in-memory store so set→get round-trips exercise the real upsert
// semantics, while `now` is injected so expiry is deterministic (no fake timers).
type Row = { cacheKey: string; value: unknown; expiresAt: Date; createdAt: Date };

const { store, state } = vi.hoisted(() => ({
  store: new Map<string, Row>(),
  state: { fail: false },
}));

vi.mock("@/lib/db", () => ({
  db: () => ({
    apiCache: {
      findUnique: ({ where: { cacheKey } }: { where: { cacheKey: string } }) => {
        if (state.fail) return Promise.reject(new Error("DB unreachable"));
        return Promise.resolve(store.get(cacheKey) ?? null);
      },
      upsert: ({
        where: { cacheKey },
        create,
        update,
      }: {
        where: { cacheKey: string };
        create: { cacheKey: string; value: unknown; expiresAt: Date };
        update: { value: unknown; expiresAt: Date };
      }) => {
        if (state.fail) return Promise.reject(new Error("DB unreachable"));
        const existing = store.get(cacheKey);
        if (existing) {
          store.set(cacheKey, { ...existing, ...update });
        } else {
          store.set(cacheKey, { ...create, createdAt: new Date(0) });
        }
        return Promise.resolve(store.get(cacheKey));
      },
    },
  }),
}));

beforeEach(() => {
  store.clear();
  state.fail = false;
  __resetApiCacheL1ForTests();
});

describe("api-cache", () => {
  const now = new Date("2026-07-15T12:00:00Z");
  const future = new Date("2026-07-15T13:00:00Z");
  const past = new Date("2026-07-15T11:00:00Z");

  it("set → get returns the stored value while unexpired", async () => {
    await setCached("geo:unirii", { lat: 44.43, lng: 26.1 }, future);
    await expect(getCached("geo:unirii", now)).resolves.toEqual({ lat: 44.43, lng: 26.1 });
  });

  it("returns null for a row whose expiresAt is in the past", async () => {
    await setCached("stale", { x: 1 }, past);
    await expect(getCached("stale", now)).resolves.toBeNull();
  });

  it("treats expiresAt === now as a miss (expiry is exclusive, > now)", async () => {
    await setCached("boundary", { x: 1 }, now);
    await expect(getCached("boundary", now)).resolves.toBeNull();
  });

  it("returns null for a key that was never set", async () => {
    await expect(getCached("absent", now)).resolves.toBeNull();
  });

  it("overwrites value and expiry on a second set for the same key", async () => {
    await setCached("k", { v: "old" }, past); // already expired
    await setCached("k", { v: "new" }, future); // refreshed
    await expect(getCached("k", now)).resolves.toEqual({ v: "new" });
  });

  it("strict getCached rejects when the DB is unreachable", async () => {
    state.fail = true;
    await expect(getCached("x", now)).rejects.toThrow(/DB unreachable/);
  });

  it("serves a warm L1 hit without a second DB round-trip", async () => {
    await setCached("warm", { n: 1 }, future);
    const findUnique = vi.spyOn(
      // The mock is recreated per call; count store reads instead.
      { get: (k: string) => store.get(k) },
      "get",
    );
    // First get may use L1 filled by setCached — clear L1 and read from DB once.
    __resetApiCacheL1ForTests();
    await expect(getCached("warm", now)).resolves.toEqual({ n: 1 });
    const sizeBefore = store.size;
    // Second get must be L1-only: corrupt the store and still hit.
    store.clear();
    await expect(getCached("warm", now)).resolves.toEqual({ n: 1 });
    expect(store.size).toBe(0);
    expect(sizeBefore).toBe(1);
    findUnique.mockRestore();
  });
});

describe("best-effort cache (provider layer)", () => {
  const future = new Date("2026-07-15T13:00:00Z");
  const now = new Date("2026-07-15T12:00:00Z");
  // Failures warn (throttled, asserted below) — silence the output here.
  const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
  afterEach(() => warned.mockClear());

  it("getCachedSafe returns null (cache miss) when the DB throws — flow degrades, not fails", async () => {
    state.fail = true;
    await expect(getCachedSafe("x", now)).resolves.toBeNull();
  });

  it("setCachedSafe swallows a DB write failure", async () => {
    state.fail = true;
    await expect(setCachedSafe("x", { a: 1 }, future)).resolves.toBeUndefined();
  });

  it("warns on the first failure, suppresses within 60s, warns again after", async () => {
    vi.useFakeTimers();
    try {
      state.fail = true;
      // Far future: warns emitted by earlier tests (real clock) can't suppress these.
      vi.setSystemTime(new Date("2027-01-01T00:00:00Z"));
      await getCachedSafe("a", now);
      expect(warned).toHaveBeenCalledTimes(1);
      expect(warned.mock.calls[0]?.[0]).toContain("[api-cache] best-effort read failed");

      vi.setSystemTime(new Date("2027-01-01T00:00:30Z")); // inside the interval
      await setCachedSafe("a", 1, future);
      expect(warned).toHaveBeenCalledTimes(1);

      vi.setSystemTime(new Date("2027-01-01T00:01:01Z")); // interval elapsed
      await setCachedSafe("b", 2, future);
      expect(warned).toHaveBeenCalledTimes(2);
      expect(warned.mock.calls[1]?.[0]).toContain("best-effort write failed");
    } finally {
      vi.useRealTimers();
    }
  });
});
