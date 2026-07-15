import { beforeEach, describe, expect, it, vi } from "vitest";

import { getCached, setCached } from "./api-cache";

// getCached/setCached compose db().apiCache with a time comparison. We back the
// mock with an in-memory store so set→get round-trips exercise the real upsert
// semantics, while `now` is injected so expiry is deterministic (no fake timers).
type Row = { cacheKey: string; value: unknown; expiresAt: Date; createdAt: Date };

const { store } = vi.hoisted(() => ({ store: new Map<string, Row>() }));

vi.mock("@/lib/db", () => ({
  db: () => ({
    apiCache: {
      findUnique: ({ where: { cacheKey } }: { where: { cacheKey: string } }) =>
        Promise.resolve(store.get(cacheKey) ?? null),
      upsert: ({
        where: { cacheKey },
        create,
        update,
      }: {
        where: { cacheKey: string };
        create: { cacheKey: string; value: unknown; expiresAt: Date };
        update: { value: unknown; expiresAt: Date };
      }) => {
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
});
