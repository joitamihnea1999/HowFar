import { beforeEach, describe, expect, it, vi } from "vitest";

const { walkingIsochrone, walkingPresetIsochrone } = vi.hoisted(() => ({
  walkingIsochrone: vi.fn(),
  walkingPresetIsochrone: vi.fn(),
}));
vi.mock("@/features/isochrones/server/ors", () => ({ walkingIsochrone, walkingPresetIsochrone }));

import { ProviderError } from "@/lib/provider-http";

import { GET } from "./route";

const call = (qs: string) => GET(new Request(`http://localhost/api/isochrone${qs}`));

// Braces matter: mockReset() returns the mock, and a function returned from
// beforeEach runs as a TEARDOWN that would call the mock after every test.
beforeEach(() => {
  walkingIsochrone.mockReset();
  walkingPresetIsochrone.mockReset();
});

describe("GET /api/isochrone", () => {
  it("400 on invalid coords", async () => {
    expect((await call("?lat=abc&lng=26")).status).toBe(400);
  });

  it("422 outside the Bucharest area (no provider call)", async () => {
    expect((await call("?lat=46.77&lng=23.6")).status).toBe(422);
    expect(walkingIsochrone).not.toHaveBeenCalled();
  });

  it("200 + isochrone on success", async () => {
    const result = { origin: { lat: 44.4268, lng: 26.1025 }, rings: [{ minutes: 15, geometry: {} }] };
    walkingIsochrone.mockResolvedValue(result);
    const res = await call("?lat=44.4268&lng=26.1025");
    expect(res.status).toBe(200);
    expect((await res.json()).rings).toHaveLength(1);
  });

  it("model absent → LEGACY walk path (preset never called)", async () => {
    walkingIsochrone.mockResolvedValue({ origin: {}, rings: [{ minutes: 15, geometry: {} }] });
    await call("?lat=44.4268&lng=26.1025");
    expect(walkingIsochrone).toHaveBeenCalledTimes(1);
    expect(walkingPresetIsochrone).not.toHaveBeenCalled();
  });

  it("model=preset → PRESET walk path (legacy never called); route SLICES to the [10,20] chips, DROPS the 40 union-helper ring", async () => {
    // `walkingPresetIsochrone` returns the full [10,20,40] fetch (40 is the transit
    // union helper). The walk route must serve only the selectable chips [10,20] —
    // the 40-min contour was held out of the served honesty bar and is not a walk reach.
    walkingPresetIsochrone.mockResolvedValue({
      origin: {}, rings: [10, 20, 40].map((m) => ({ minutes: m, geometry: {} })),
    });
    const res = await call("?lat=44.4268&lng=26.1025&model=preset");
    expect(res.status).toBe(200);
    expect((await res.json()).rings.map((r: { minutes: number }) => r.minutes)).toEqual([10, 20]);
    expect(walkingPresetIsochrone).toHaveBeenCalledTimes(1);
    expect(walkingIsochrone).not.toHaveBeenCalled();
  });

  it("model=preset → 502 (fail-loud), NOT an empty 200, if the sliced chip set is empty (constant drift guard)", async () => {
    // Simulate WALK_PRESET_MIN drifting away from the fetched set: the fetch has no
    // chip-labelled ring, so the slice is []. The route must 502, not serve zero reach.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    walkingPresetIsochrone.mockResolvedValue({
      origin: {}, rings: [40].map((m) => ({ minutes: m, geometry: {} })),
    });
    expect((await call("?lat=44.4268&lng=26.1025&model=preset")).status).toBe(502);
    logged.mockRestore();
  });

  it("400 on an unknown model (e.g. a typo) with NO provider call — fail-loud, never a silent legacy fall-through", async () => {
    expect((await call("?lat=44.4268&lng=26.1025&model=presett")).status).toBe(400);
    expect(walkingIsochrone).not.toHaveBeenCalled();
    expect(walkingPresetIsochrone).not.toHaveBeenCalled();
  });

  it("502 + a logged cause when the provider fails", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    walkingIsochrone.mockRejectedValue(new ProviderError("openrouteservice responded 429"));
    expect((await call("?lat=44.4268&lng=26.1025")).status).toBe(502);
    expect(logged).toHaveBeenCalledExactlyOnceWith("[api:isochrone] ProviderError: openrouteservice responded 429");
    logged.mockRestore();
  });
});
