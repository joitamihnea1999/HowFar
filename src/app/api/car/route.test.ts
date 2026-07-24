import { beforeEach, describe, expect, it, vi } from "vitest";

const { drivingIsochrone } = vi.hoisted(() => ({ drivingIsochrone: vi.fn() }));
vi.mock("@/features/isochrones/server/ors", () => ({ drivingIsochrone }));

import { ProviderError } from "@/lib/provider-http";

import { GET } from "./route";

const call = (qs: string) => GET(new Request(`http://localhost/api/car${qs}`));

// Braces matter: a value returned from beforeEach runs as TEARDOWN.
beforeEach(() => {
  drivingIsochrone.mockReset();
});

describe("GET /api/car", () => {
  it("400 on invalid coords", async () => {
    expect((await call("?lat=abc&lng=26")).status).toBe(400);
  });

  it("422 outside the Bucharest area (no provider call)", async () => {
    expect((await call("?lat=46.77&lng=23.6")).status).toBe(422);
    expect(drivingIsochrone).not.toHaveBeenCalled();
  });

  it("200 + isochrone on success", async () => {
    const result = { origin: { lat: 44.4268, lng: 26.1025 }, rings: [{ minutes: 10, geometry: {} }] };
    drivingIsochrone.mockResolvedValue(result);
    const res = await call("?lat=44.4268&lng=26.1025");
    expect(res.status).toBe(200);
    expect((await res.json()).rings).toHaveLength(1);
  });

  it("ignores pace/preset/time params — car is a fixed profile (called with lat/lng only)", async () => {
    drivingIsochrone.mockResolvedValue({ origin: { lat: 44.4268, lng: 26.1025 }, rings: [] });
    await call("?lat=44.4268&lng=26.1025&pace=brisk&preset=weekday-morning&time=08:30");
    // The route never forwards pace/time: drivingIsochrone takes only (lat,lng).
    expect(drivingIsochrone).toHaveBeenCalledExactlyOnceWith(44.4268, 26.1025);
  });

  it("502 + a logged cause when the provider fails", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    drivingIsochrone.mockRejectedValue(new ProviderError("openrouteservice responded 429"));
    expect((await call("?lat=44.4268&lng=26.1025")).status).toBe(502);
    expect(logged).toHaveBeenCalledExactlyOnceWith("[api:car] ProviderError: openrouteservice responded 429");
    logged.mockRestore();
  });
});
