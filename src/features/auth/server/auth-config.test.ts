import { describe, expect, it } from "vitest";

import { configuredProviders } from "./auth-config";

describe("configuredProviders", () => {
  it("returns [] when nothing is configured", () => {
    expect(configuredProviders({})).toEqual([]);
  });

  it("requires the FULL pair — an id without its secret does not count", () => {
    expect(configuredProviders({ AUTH_GOOGLE_ID: "id" })).toEqual([]);
    expect(configuredProviders({ AUTH_GITHUB_SECRET: "s" })).toEqual([]);
  });

  it("lists each provider whose pair is complete", () => {
    expect(
      configuredProviders({
        AUTH_GOOGLE_ID: "gid",
        AUTH_GOOGLE_SECRET: "gs",
        AUTH_GITHUB_ID: "hid",
        AUTH_GITHUB_SECRET: "hs",
      }),
    ).toEqual(["google", "github"]);
    expect(configuredProviders({ AUTH_GITHUB_ID: "hid", AUTH_GITHUB_SECRET: "hs" })).toEqual(["github"]);
  });

  it("treats whitespace-only values as absent (same trim semantics as parseServerEnv)", () => {
    expect(configuredProviders({ AUTH_GOOGLE_ID: "  ", AUTH_GOOGLE_SECRET: "gs" })).toEqual([]);
  });
});
