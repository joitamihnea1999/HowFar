import { beforeEach, describe, expect, it, vi } from "vitest";

const { probeDb } = vi.hoisted(() => ({ probeDb: vi.fn() }));
vi.mock("@/lib/health", () => ({ probeDb }));

import { GET } from "./route";

// Braces matter: a function returned from beforeEach runs as a teardown.
beforeEach(() => {
  probeDb.mockReset();
});

describe("GET /api/ready (readiness — Railway healthcheck + Playwright gate)", () => {
  it("200 when the database is reachable", async () => {
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
});
