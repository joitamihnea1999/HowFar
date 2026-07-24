import { beforeEach, describe, expect, it, vi } from "vitest";

const { drivingIsochrone } = vi.hoisted(() => ({ drivingIsochrone: vi.fn() }));
vi.mock("@/features/isochrones/server/ors", () => ({ drivingIsochrone }));

import { ProviderError } from "@/lib/provider-http";

import { GET } from "./route";

const call = (qs: string) => GET(new Request(`http://localhost/api/car${qs}`));

// Braces matter: a value returned from beforeEach runs as TEARDOWN.
beforeEach(() => {
  drivingIsochrone.mockReset();
  drivingIsochrone.mockResolvedValue({ origin: { lat: 44.4268, lng: 26.1025 }, rings: [] });
});

describe("GET /api/car", () => {
  it("400 on invalid coords", async () => {
    expect((await call("?lat=abc&lng=26")).status).toBe(400);
  });

  it("422 outside the Bucharest area (no provider call)", async () => {
    expect((await call("?lat=46.77&lng=23.6")).status).toBe(422);
    expect(drivingIsochrone).not.toHaveBeenCalled();
  });

  it("400 on a malformed departure time (never a silent fallback)", async () => {
    expect((await call("?lat=44.4268&lng=26.1025&weekday=9&time=nope")).status).toBe(400);
    expect(drivingIsochrone).not.toHaveBeenCalled();
  });

  it("200 + isochrone on success, with a car meta block", async () => {
    const result = { origin: { lat: 44.4268, lng: 26.1025 }, rings: [{ minutes: 10, geometry: {} }] };
    drivingIsochrone.mockResolvedValue(result);
    const res = await call("?lat=44.4268&lng=26.1025");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rings).toHaveLength(1);
    // Default (no params) resolves weekday-morning → am-peak, basis estimate.
    expect(body.car).toEqual({ basis: "estimate", slotId: "am-peak", slotLabel: "weekday morning rush", factor: 2.1 });
  });

  it("resolves the traffic slot from a preset and passes it to the isochrone", async () => {
    await call("?lat=44.4268&lng=26.1025&preset=weekend");
    expect(drivingIsochrone).toHaveBeenCalledTimes(1);
    const slot = drivingIsochrone.mock.calls[0][2];
    expect(slot.slotId).toBe("weekend-day");
    expect(drivingIsochrone.mock.calls[0].slice(0, 2)).toEqual([44.4268, 26.1025]);
  });

  it("resolves the traffic slot from a custom weekday+time", async () => {
    await call("?lat=44.4268&lng=26.1025&weekday=2&time=18:00");
    expect(drivingIsochrone.mock.calls[0][2].slotId).toBe("pm-peak");
  });

  it("ignores a leftover pace param — car has no pace", async () => {
    const res = await call("?lat=44.4268&lng=26.1025&pace=brisk");
    expect(res.status).toBe(200);
    expect(drivingIsochrone.mock.calls[0][2].slotId).toBe("am-peak");
  });

  it("502 + a logged cause when the provider fails", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    drivingIsochrone.mockRejectedValue(new ProviderError("openrouteservice responded 429"));
    expect((await call("?lat=44.4268&lng=26.1025")).status).toBe(502);
    expect(logged).toHaveBeenCalledExactlyOnceWith("[api:car] ProviderError: openrouteservice responded 429");
    logged.mockRestore();
  });
});
