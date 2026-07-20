import { beforeEach, describe, expect, it, vi } from "vitest";

import { probeDb } from "./health";

// probeDb composes db() + withTimeout; these tests pin the composition
// (the deploy healthcheck contract) without needing Docker.
const { queryRaw, dbFactory } = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  dbFactory: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: () => {
    dbFactory();
    return { $queryRaw: queryRaw };
  },
}));

beforeEach(() => {
  queryRaw.mockReset();
  dbFactory.mockReset();
});

describe("probeDb", () => {
  it("returns true when PostgreSQL has PostGIS and migration history", async () => {
    queryRaw.mockResolvedValue([{ postgis: true, migrations: true }]);
    await expect(probeDb()).resolves.toBe(true);
  });

  it("returns false when the database is reachable but incomplete", async () => {
    queryRaw.mockResolvedValue([{ postgis: false, migrations: true }]);
    await expect(probeDb()).resolves.toBe(false);
  });

  it("returns false when the query rejects (connection refused)", async () => {
    queryRaw.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(probeDb()).resolves.toBe(false);
  });

  it("returns false within the bound when the query hangs", async () => {
    queryRaw.mockReturnValue(new Promise(() => {})); // never settles
    const started = Date.now();
    await expect(probeDb(50)).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("returns false when db() itself throws (missing DATABASE_URL)", async () => {
    dbFactory.mockImplementation(() => {
      throw new Error("EnvError: DATABASE_URL");
    });
    await expect(probeDb()).resolves.toBe(false);
  });
});
