import { beforeEach, describe, expect, it, vi } from "vitest";

const { transitIsochrone, transitPresetIsochrone } = vi.hoisted(() => ({
  transitIsochrone: vi.fn(),
  transitPresetIsochrone: vi.fn(),
}));
vi.mock("@/features/isochrones/server/transit", () => ({ transitIsochrone, transitPresetIsochrone }));

import { ProviderError } from "@/lib/provider-http";

import { GET } from "./route";

const call = (qs: string) => GET(new Request(`http://localhost/api/transit${qs}`));

// Braces matter: mockReset() returns the mock, and a function returned from
// beforeEach runs as a TEARDOWN that would call the mock after every test.
beforeEach(() => {
  transitIsochrone.mockReset();
  transitPresetIsochrone.mockReset();
});

describe("GET /api/transit", () => {
  it("400 on invalid coords", async () => {
    expect((await call("?lat=abc&lng=26")).status).toBe(400);
  });

  it("400 on blank/absent coords", async () => {
    expect((await call("?lat=&lng=")).status).toBe(400);
    expect((await call("")).status).toBe(400);
  });

  it("422 outside the Bucharest area (no provider call)", async () => {
    expect((await call("?lat=46.77&lng=23.6")).status).toBe(422);
    expect(transitIsochrone).not.toHaveBeenCalled();
  });

  it("200 + rings on success", async () => {
    const result = {
      origin: { lat: 44.4268, lng: 26.1025 },
      rings: [
        { minutes: 15, geometry: { type: "MultiPolygon", coordinates: [] } },
        { minutes: 30, geometry: { type: "MultiPolygon", coordinates: [] } },
        { minutes: 45, geometry: { type: "MultiPolygon", coordinates: [] } },
      ],
    };
    transitIsochrone.mockResolvedValue(result);
    const res = await call("?lat=44.4268&lng=26.1025");
    expect(res.status).toBe(200);
    expect((await res.json()).rings).toHaveLength(3);
    expect(transitPresetIsochrone).not.toHaveBeenCalled();
  });

  it("model=preset → PRESET transit path ([20,40]) with legacy never called; typo → 400 no provider call", async () => {
    transitPresetIsochrone.mockResolvedValue({
      origin: { lat: 44.4268, lng: 26.1025 },
      departure: "2026-09-09T05:30:00Z",
      rings: [20, 40].map((m) => ({ minutes: m, geometry: { type: "MultiPolygon", coordinates: [] } })),
    });
    const res = await call("?lat=44.4268&lng=26.1025&model=preset");
    expect(res.status).toBe(200);
    expect((await res.json()).rings.map((r: { minutes: number }) => r.minutes)).toEqual([20, 40]);
    expect(transitPresetIsochrone).toHaveBeenCalledTimes(1);
    expect(transitIsochrone).not.toHaveBeenCalled();
    expect((await call("?lat=44.4268&lng=26.1025&model=presett")).status).toBe(400);
    expect(transitIsochrone).not.toHaveBeenCalled();
  });

  it("502 + a logged cause when the provider fails", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    transitIsochrone.mockRejectedValue(new ProviderError("transitous responded 503"));
    expect((await call("?lat=44.4268&lng=26.1025")).status).toBe(502);
    expect(logged).toHaveBeenCalledExactlyOnceWith("[api:transit] ProviderError: transitous responded 503");
    logged.mockRestore();
  });
});
