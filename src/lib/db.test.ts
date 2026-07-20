import { describe, expect, it } from "vitest";

import { poolConfig } from "./db";

describe("poolConfig", () => {
  it("passes the PostgreSQL URL through to node-postgres", () => {
    const url = "postgresql://howfar:pw@db.internal:5432/howfar?sslmode=require";
    expect(poolConfig(url).connectionString).toBe(url);
  });

  it("bounds pool size, connection acquisition, idleness, and SQL execution", () => {
    const cfg = poolConfig("postgresql://u:p@h:5432/db");
    expect(cfg).toMatchObject({
      application_name: "howfar",
      max: 10,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 10_000,
      statement_timeout: 10_000,
    });
  });
});
