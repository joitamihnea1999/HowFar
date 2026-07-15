import { describe, expect, it } from "vitest";

import { resolveAuthView } from "./auth-view";

describe("resolveAuthView", () => {
  it("signed-in: prefers the user's name for the label", () => {
    expect(resolveAuthView({ name: "Ana", email: "ana@example.com" }, [])).toEqual({
      mode: "signed-in",
      label: "Ana",
    });
  });

  it("signed-in: falls back to email when name is blank", () => {
    expect(resolveAuthView({ name: "  ", email: "ana@example.com" }, ["github"])).toEqual({
      mode: "signed-in",
      label: "ana@example.com",
    });
  });

  it("signed-in: falls back to 'Account' when name and email are absent", () => {
    expect(resolveAuthView({}, [])).toEqual({ mode: "signed-in", label: "Account" });
  });

  it("sign-in: lists configured providers when signed out", () => {
    expect(resolveAuthView(null, ["google", "github"])).toEqual({
      mode: "sign-in",
      providers: ["google", "github"],
    });
  });

  it("unavailable: signed out with no configured providers", () => {
    expect(resolveAuthView(null, [])).toEqual({ mode: "unavailable" });
    expect(resolveAuthView(undefined, [])).toEqual({ mode: "unavailable" });
  });
});
