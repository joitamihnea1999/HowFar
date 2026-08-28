import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { probeDb } = vi.hoisted(() => ({ probeDb: vi.fn() }));
// Small timeout so the "never settles" hang test below completes fast; correctness
// tests resolve well within it.
vi.mock("@/lib/health", () => ({ probeDb, DB_PROBE_TIMEOUT_MS: 50 }));

// Readiness now also reads the active amenity dataset (region cross-check, task 013),
// so `db()` must be mocked — without it `db()` builds a real Prisma pool. Default:
// no active dataset ⇒ readiness is unaffected by the catalogue (unchanged behavior).
const { findActive } = vi.hoisted(() => ({ findActive: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: () => ({ amenityDataset: { findUnique: findActive } }),
}));

import { GET } from "./route";

beforeEach(() => {
  probeDb.mockReset();
  findActive.mockReset();
  findActive.mockResolvedValue(null); // no active dataset by default
});
afterEach(() => vi.unstubAllEnvs());

describe("GET /api/ready (readiness — deployment healthcheck + Playwright gate)", () => {
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

  // ---- region cross-check (task 013) ----

  it("503 when the active catalogue's region does not match the configured extent (post-flip deploy) and logs the configured vs recorded boxes", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    probeDb.mockResolvedValue(true);
    findActive.mockResolvedValue({
      validation: { source: { bbox: { minLng: 23.4, minLat: 46.6, maxLng: 23.7, maxLat: 46.9 } } },
    });
    const res = await GET();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ready: false });
    // The deploy-failing log must carry the same configured-vs-recorded detail the
    // other serving surfaces emit, so an operator can see WHY readiness failed —
    // BOTH the configured (default) box and the foreign recorded box, not a generic
    // phrase (a revert to the old static string must fail this).
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("[25.8,44.2,26.4,44.7]"));
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("[23.4,46.6,23.7,46.9]"));
    errSpy.mockRestore();
  });

  it("503 when the region query NEVER settles — the probe is time-bounded, not hung (fail closed)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    probeDb.mockResolvedValue(true);
    findActive.mockImplementation(() => new Promise(() => {})); // never resolves
    const res = await GET();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ready: false });
    errSpy.mockRestore();
  });

  it("200 when the active catalogue's region matches the configured (default) extent", async () => {
    probeDb.mockResolvedValue(true);
    findActive.mockResolvedValue({
      validation: { source: { bbox: { minLng: 25.8, minLat: 44.2, maxLng: 26.4, maxLat: 44.7 } } },
    });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ready: true });
  });

  it("200 when there is NO active catalogue — presence is /api/catalogue-status's concern, not readiness (deploy-ordering)", async () => {
    probeDb.mockResolvedValue(true);
    findActive.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ready: true });
  });

  it("503 (fail closed) when the region query itself throws — an unverifiable region must not pass", async () => {
    probeDb.mockResolvedValue(true);
    findActive.mockImplementation(async () => {
      throw new Error("permission denied for table AmenityDataset");
    });
    const res = await GET();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ready: false });
  });

  it("does NOT probe the region when the database is already down (no second failure surface)", async () => {
    probeDb.mockResolvedValue(false);
    await GET();
    expect(findActive).not.toHaveBeenCalled();
  });
});
