import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import { db } from "@/lib/db";

// The ordinary unit suite stays database-independent. CI and local foundation
// checks opt in after applying migrations with `npm run test:db`.
const describePostgres = process.env.POSTGIS_INTEGRATION === "1" ? describe : describe.skip;

describePostgres("PostgreSQL/PostGIS foundation", () => {
  const suffix = randomUUID();
  const userId = `integration-user-${suffix}`;
  const cacheKey = `integration-cache-${suffix}`;
  const verificationToken = `integration-token-${suffix}`;

  afterAll(async () => {
    await db().apiCache.deleteMany({ where: { cacheKey } });
    await db().verificationToken.deleteMany({ where: { token: verificationToken } });
    await db().user.deleteMany({ where: { id: userId } });
    await db().$disconnect();
  });

  it("loads PostGIS in the migrated database", async () => {
    const rows = await db().$queryRaw<Array<{ version: string }>>`
      SELECT PostGIS_Version() AS version
    `;
    expect(rows[0]?.version).toMatch(/^3\./);
  });

  it("round-trips Auth.js, SavedSearch, and ApiCache models", async () => {
    await db().user.create({
      data: {
        id: userId,
        email: `integration-${suffix}@example.invalid`,
        accounts: {
          create: {
            type: "oauth",
            provider: "integration",
            providerAccountId: suffix,
          },
        },
        sessions: {
          create: {
            sessionToken: `integration-session-${suffix}`,
            expires: new Date("2030-01-01T00:00:00.000Z"),
          },
        },
        savedSearches: {
          create: {
            query: "Apărătorii Patriei, București",
            lat: 44.365,
            lng: 26.146,
            params: { minutes: 15, modes: ["walk"] },
          },
        },
      },
    });

    await db().verificationToken.create({
      data: {
        identifier: `integration-${suffix}@example.invalid`,
        token: verificationToken,
        expires: new Date("2030-01-01T00:00:00.000Z"),
      },
    });

    await db().apiCache.upsert({
      where: { cacheKey },
      create: {
        cacheKey,
        value: { provider: "ors", ok: true },
        expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      },
      update: { value: { provider: "ors", ok: true } },
    });

    const user = await db().user.findUniqueOrThrow({
      where: { id: userId },
      include: { accounts: true, sessions: true, savedSearches: true },
    });
    const cached = await db().apiCache.findUniqueOrThrow({ where: { cacheKey } });

    expect(user.accounts).toHaveLength(1);
    expect(user.sessions).toHaveLength(1);
    expect(user.savedSearches[0]).toMatchObject({
      query: "Apărătorii Patriei, București",
      lat: 44.365,
      lng: 26.146,
    });
    expect(cached.value).toEqual({ provider: "ors", ok: true });
  });
});
