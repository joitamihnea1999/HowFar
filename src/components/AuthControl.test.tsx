import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import AuthControl from "./AuthControl";

// Cover the JSX branches of the AuthControl server component without a DOM
// harness: mock @/auth, invoke the async component as a function, and read the
// text out of the returned React element tree. The inline signIn/signOut server
// actions are only called on form submit, so mocking them as no-ops is enough.
const { state } = vi.hoisted(() => ({
  state: { session: null as { user?: { name?: string | null; email?: string | null } } | null, providers: [] as string[] },
}));

vi.mock("@/auth", () => ({
  auth: () => Promise.resolve(state.session),
  configuredProviders: () => state.providers,
  signIn: vi.fn(),
  signOut: vi.fn(),
}));

function text(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  if (typeof node === "object" && "props" in node) {
    return text((node as { props?: { children?: ReactNode } }).props?.children);
  }
  return "";
}

beforeEach(() => {
  state.session = null;
  state.providers = [];
});

describe("AuthControl", () => {
  it("signed-in: renders the user label and a Sign out control", async () => {
    state.session = { user: { name: "Ana Pop", email: "ana@example.com" } };
    const rendered = text(await AuthControl());
    expect(rendered).toContain("Ana Pop");
    expect(rendered).toContain("Sign out");
  });

  it("sign-in: renders a provider button when signed out with a configured provider", async () => {
    state.providers = ["github"];
    const rendered = text(await AuthControl());
    expect(rendered).toContain("Sign in with GitHub");
  });

  it("unavailable: renders the muted note when no provider is configured", async () => {
    const rendered = text(await AuthControl());
    expect(rendered).toContain("Sign-in unavailable");
  });
});
