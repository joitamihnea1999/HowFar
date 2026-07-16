import { describe, expect, it } from "vitest";

import { poolConfig } from "./db";

describe("poolConfig", () => {
  it("maps a full URL to host/port/user/password/database", () => {
    expect(poolConfig("mysql://howfar:pw@db.internal:3307/howfar")).toMatchObject({
      host: "db.internal",
      port: 3307,
      user: "howfar",
      password: "pw",
      database: "howfar",
    });
  });

  it("defaults the port to 3306 when the URL has none", () => {
    expect(poolConfig("mysql://u:p@localhost/howfar").port).toBe(3306);
  });

  it("decodes percent-encoded credentials (Railway passwords often need it)", () => {
    const cfg = poolConfig("mysql://user%40app:p%40ss%2Fword@host:3306/db");
    expect(cfg.user).toBe("user@app");
    expect(cfg.password).toBe("p@ss/word");
  });

  it("strips the leading slash from the database path", () => {
    expect(poolConfig("mysql://u:p@h:3306/railway").database).toBe("railway");
  });

  it("bounds connect and acquire at 5s so a dead DB fails fast", () => {
    const cfg = poolConfig("mysql://u:p@h:3306/db");
    expect(cfg.connectTimeout).toBe(5_000);
    expect(cfg.acquireTimeout).toBe(5_000);
  });
});
