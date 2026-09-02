import { describe, expect, it } from "vitest";

import { parseAllowedDevOrigins } from "@/lib/dev-origins";

describe("parseAllowedDevOrigins", () => {
  it("returns undefined when unset or empty (byte-identical to no allowedDevOrigins key)", () => {
    expect(parseAllowedDevOrigins(undefined)).toBeUndefined();
    expect(parseAllowedDevOrigins("")).toBeUndefined();
    expect(parseAllowedDevOrigins("   ")).toBeUndefined();
    expect(parseAllowedDevOrigins(" , , ")).toBeUndefined();
  });

  it("keeps a bare hostname / LAN IP as-is", () => {
    expect(parseAllowedDevOrigins("192.168.1.42")).toEqual(["192.168.1.42"]);
    expect(parseAllowedDevOrigins("local-origin.dev")).toEqual(["local-origin.dev"]);
  });

  it("normalizes a scheme+port URL down to the bare hostname (Next matches HOSTNAME only)", () => {
    expect(parseAllowedDevOrigins("http://192.168.1.42:3000")).toEqual(["192.168.1.42"]);
    expect(parseAllowedDevOrigins("192.168.1.42:3000")).toEqual(["192.168.1.42"]);
    expect(parseAllowedDevOrigins("https://phone.local:8080/")).toEqual(["phone.local"]);
  });

  it("splits a comma list, trims, drops empties, and lowercases", () => {
    expect(parseAllowedDevOrigins(" 192.168.1.42 , ,Phone.Local ")).toEqual(["192.168.1.42", "phone.local"]);
  });

  it("preserves a wildcard subdomain entry", () => {
    expect(parseAllowedDevOrigins("*.local-origin.dev")).toEqual(["*.local-origin.dev"]);
  });
});
