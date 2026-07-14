import { describe, expect, it } from "vitest";

import { EnvError, parseServerEnv } from "./env";

const valid = {
  DATABASE_URL: "mysql://user:pass@localhost:3307/howfar",
  AUTH_SECRET: "s3cret",
};

describe("parseServerEnv", () => {
  it("parses a minimal valid environment", () => {
    const env = parseServerEnv(valid);
    expect(env.databaseUrl).toBe(valid.DATABASE_URL);
    expect(env.authSecret).toBe("s3cret");
    expect(env.googleClientId).toBeUndefined();
    expect(env.orsApiKey).toBeUndefined();
  });

  it("throws EnvError when DATABASE_URL is missing", () => {
    expect(() => parseServerEnv({ AUTH_SECRET: "x" })).toThrowError(EnvError);
    expect(() => parseServerEnv({ AUTH_SECRET: "x" })).toThrowError(/DATABASE_URL/);
  });

  it("rejects non-mysql connection strings (MySQL is mandatory per brief)", () => {
    expect(() => parseServerEnv({ ...valid, DATABASE_URL: "postgres://nope" })).toThrowError(
      /must start with mysql/,
    );
  });

  it("throws EnvError when AUTH_SECRET is missing (required even without OAuth)", () => {
    expect(() => parseServerEnv({ DATABASE_URL: valid.DATABASE_URL })).toThrowError(/AUTH_SECRET/);
  });

  it("treats empty/whitespace values as absent", () => {
    expect(() => parseServerEnv({ ...valid, AUTH_SECRET: "   " })).toThrowError(/AUTH_SECRET/);
    const env = parseServerEnv({ ...valid, AUTH_GOOGLE_ID: "  " });
    expect(env.googleClientId).toBeUndefined();
  });

  it("picks up optional OAuth pairs and ORS key when present", () => {
    const env = parseServerEnv({
      ...valid,
      AUTH_GITHUB_ID: "gh-id",
      AUTH_GITHUB_SECRET: "gh-secret",
      ORS_API_KEY: "ors-key",
    });
    expect(env.githubClientId).toBe("gh-id");
    expect(env.githubClientSecret).toBe("gh-secret");
    expect(env.orsApiKey).toBe("ors-key");
  });
});
