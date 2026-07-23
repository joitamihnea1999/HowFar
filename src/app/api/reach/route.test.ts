import { beforeEach, describe, expect, it, vi } from "vitest";

const { planTrip } = vi.hoisted(() => ({ planTrip: vi.fn() }));
vi.mock("@/features/isochrones/server/transit-plan", () => ({ planTrip }));

import { ProviderError } from "@/lib/provider-http";
import { GET } from "./route";

// Inside Bucharest; a clearly out-of-area point (Paris) for the guard tests.
const FROM = "fromLat=44.3760&fromLng=26.1250";
const TO = "toLat=44.4780&toLng=26.1280";
const call = (query: string) => GET(new Request(`http://localhost/api/reach?${query}`));

beforeEach(() => planTrip.mockReset());

describe("GET /api/reach", () => {
  it("rejects malformed / missing coordinates with 400 and ZERO provider calls (P9)", async () => {
    expect((await call(`${TO}`)).status).toBe(400); // no from
    expect((await call(`${FROM}`)).status).toBe(400); // no to
    expect((await call(`fromLat=nope&fromLng=26.1&${TO}`)).status).toBe(400);
    expect((await call(`fromLat=&fromLng=&${TO}`)).status).toBe(400);
    expect(planTrip).not.toHaveBeenCalled();
  });

  it("area-guards BOTH points with 422 before any provider call (P9)", async () => {
    // Out-of-area origin (Paris) → 422, no plan.
    expect((await call(`fromLat=48.85&fromLng=2.35&${TO}&preset=weekday-morning`)).status).toBe(422);
    // Out-of-area destination → 422, no plan.
    expect((await call(`${FROM}&toLat=48.85&toLng=2.35&preset=weekday-morning`)).status).toBe(422);
    expect(planTrip).not.toHaveBeenCalled();
  });

  it("rejects an invalid time context (no departure ISO, bad preset) with 400", async () => {
    expect((await call(`${FROM}&${TO}&preset=not-a-preset`)).status).toBe(400);
    expect(planTrip).not.toHaveBeenCalled();
  });

  it("plans the trip using the client's resolved departure ISO (minute-rounded) when it's within the horizon", async () => {
    planTrip.mockResolvedValue({ reachable: true, totalMinutes: 57, transfers: 0, legs: [] });
    // Near-now + minute-aligned so it's within the ±60-day horizon regardless of
    // the runner's clock (T6), and the round-to-minute is a no-op.
    const iso = new Date(Math.round((Date.now() + 3_600_000) / 60000) * 60000).toISOString();
    const res = await call(`${FROM}&${TO}&departure=${encodeURIComponent(iso)}`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ reachable: true, totalMinutes: 57 });
    expect(planTrip).toHaveBeenCalledWith({ lat: 44.376, lng: 26.125 }, { lat: 44.478, lng: 26.128 }, iso);
  });

  it("ignores an out-of-horizon departure and derives from the time context instead (T6)", async () => {
    planTrip.mockResolvedValue({ reachable: false });
    const farFuture = new Date(Date.now() + 200 * 24 * 3600 * 1000).toISOString();
    const res = await call(`${FROM}&${TO}&departure=${encodeURIComponent(farFuture)}&preset=evening`);
    expect(res.status).toBe(200);
    // The far ISO was NOT passed through; a derived (different) ISO was used.
    expect(planTrip.mock.calls[0][2]).not.toBe(farFuture);
    expect(Number.isFinite(Date.parse(planTrip.mock.calls[0][2] as string))).toBe(true);
  });

  it("derives the departure from a preset when no ISO is supplied", async () => {
    planTrip.mockResolvedValue({ reachable: false });
    const res = await call(`${FROM}&${TO}&preset=evening`);
    expect(res.status).toBe(200);
    // Derived a concrete ISO (3rd arg) rather than passing the preset through.
    const dep = planTrip.mock.calls[0][2] as string;
    expect(Number.isFinite(Date.parse(dep))).toBe(true);
  });

  it("maps a provider failure to 502 (never 500)", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    planTrip.mockRejectedValueOnce(new ProviderError("transitous plan responded 503"));
    const res = await call(`${FROM}&${TO}&preset=weekday-morning`);
    expect(res.status).toBe(502);
    logged.mockRestore();
  });
});
