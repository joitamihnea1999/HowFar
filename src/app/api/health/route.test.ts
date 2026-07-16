import { beforeEach, describe, expect, it, vi } from "vitest";

const { probeDb } = vi.hoisted(() => ({ probeDb: vi.fn() }));
vi.mock("@/lib/health", () => ({ probeDb }));

import { GET } from "./route";

// Braces matter: a function returned from beforeEach runs as a teardown.
beforeEach(() => {
  probeDb.mockReset();
});

describe("GET /api/health (liveness)", () => {
  it("200 with db:true while the database responds", async () => {
    probeDb.mockResolvedValue(true);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, db: true });
  });

  it("STILL 200 with db:false when the database is down — liveness never 5xxs", async () => {
    probeDb.mockResolvedValue(false);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, db: false });
  });
});
