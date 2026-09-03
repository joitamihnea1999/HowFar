import { beforeEach, describe, expect, it, vi } from "vitest";

const { drivingIsochrone, drivingPresetIsochrone } = vi.hoisted(() => ({
  drivingIsochrone: vi.fn(),
  drivingPresetIsochrone: vi.fn(),
}));
vi.mock("@/features/isochrones/server/ors", () => ({ drivingIsochrone, drivingPresetIsochrone }));

import { ProviderError } from "@/lib/provider-http";

import { GET } from "./route";

const call = (qs: string) => GET(new Request(`http://localhost/api/car${qs}`));

// Braces matter: a value returned from beforeEach runs as TEARDOWN.
beforeEach(() => {
  drivingIsochrone.mockReset();
  drivingIsochrone.mockResolvedValue({ origin: { lat: 44.4268, lng: 26.1025 }, rings: [] });
  drivingPresetIsochrone.mockReset();
  drivingPresetIsochrone.mockResolvedValue({ origin: { lat: 44.4268, lng: 26.1025 }, rings: [] });
});

describe("GET /api/car", () => {
  it("400 on invalid coords", async () => {
    expect((await call("?lat=abc&lng=26")).status).toBe(400);
  });

  it("422 outside the Bucharest area (no provider call)", async () => {
    expect((await call("?lat=46.77&lng=23.6")).status).toBe(422);
    expect(drivingIsochrone).not.toHaveBeenCalled();
  });

  it("model=preset → PRESET car path (time-aware) with legacy never called; model typo → 400 no provider call", async () => {
    drivingPresetIsochrone.mockResolvedValue({
      origin: { lat: 44.4268, lng: 26.1025 }, rings: [10, 25].map((m) => ({ minutes: m, geometry: {} })),
    });
    const res = await call("?lat=44.4268&lng=26.1025&model=preset");
    expect(res.status).toBe(200);
    expect((await res.json()).rings.map((r: { minutes: number }) => r.minutes)).toEqual([10, 25]);
    expect(drivingPresetIsochrone).toHaveBeenCalledTimes(1);
    expect(drivingIsochrone).not.toHaveBeenCalled();
    // typo → fail-loud 400, neither provider called
    drivingPresetIsochrone.mockClear();
    expect((await call("?lat=44.4268&lng=26.1025&model=presett")).status).toBe(400);
    expect(drivingIsochrone).not.toHaveBeenCalled();
    expect(drivingPresetIsochrone).not.toHaveBeenCalled();
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
    // Default (no params) resolves the Crowded preset → am-peak, basis estimate.
    expect(body.car).toEqual({ basis: "estimate", slotId: "am-peak", slotLabel: "weekday morning rush", factor: 2.1 });
  });

  it("Crowded vs Not-crowded resolve to distinct traffic slots (am-peak 2.1 vs midday 1.5)", async () => {
    await call("?lat=44.4268&lng=26.1025&preset=crowded");
    expect(drivingIsochrone.mock.calls[0][2]).toMatchObject({ slotId: "am-peak", factor: 2.1 });
    drivingIsochrone.mockClear();
    await call("?lat=44.4268&lng=26.1025&preset=quiet");
    const slot = drivingIsochrone.mock.calls[0][2];
    expect(slot).toMatchObject({ slotId: "midday", factor: 1.5 });
    expect(drivingIsochrone.mock.calls[0].slice(0, 2)).toEqual([44.4268, 26.1025]);
  });

  it("400 on retired custom weekday+time params (fail-loud, never silent default)", async () => {
    expect((await call("?lat=44.4268&lng=26.1025&weekday=2&time=18:00")).status).toBe(400);
    expect(drivingIsochrone).not.toHaveBeenCalled();
  });

  it("400 on a retired preset id (weekend/midday/evening no longer exist)", async () => {
    expect((await call("?lat=44.4268&lng=26.1025&preset=weekend")).status).toBe(400);
    expect(drivingIsochrone).not.toHaveBeenCalled();
  });

  it("ignores a leftover pace param — car has no pace", async () => {
    const res = await call("?lat=44.4268&lng=26.1025&pace=slow");
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
