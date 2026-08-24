import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { probeDb } = vi.hoisted(() => ({ probeDb: vi.fn() }));
vi.mock("@/lib/health", () => ({ probeDb }));

import { GET } from "./route";

// Braces matter: a function returned from beforeEach runs as a teardown.
beforeEach(() => {
  probeDb.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

describe("GET /api/ready (readiness — Railway healthcheck + Playwright gate)", () => {
  it("200 {ready:true} when the database is reachable and the provider config parses", async () => {
    probeDb.mockResolvedValue(true);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ready: true });
  });

  it("503 when the database is down — a broken deploy must report unhealthy", async () => {
    probeDb.mockResolvedValue(false);
    const res = await GET();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ready: false });
  });

  it("503 when a provider env var is set-but-invalid — fails the healthcheck, not the first request (task 007)", async () => {
    probeDb.mockResolvedValue(true);
    vi.stubEnv("ORS_BASE_URL", "not-a-url");
    const res = await GET();
    expect(res.status).toBe(503);
    // Body stays {ready:false} — the (possibly value-bearing) reason is logged
    // server-side only, never returned to an unauthenticated caller.
    const body = await res.json();
    expect(body).toEqual({ ready: false });
    expect(body.configError).toBeUndefined();
  });
});
