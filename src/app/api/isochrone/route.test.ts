import { beforeEach, describe, expect, it, vi } from "vitest";

const { walkingIsochrone } = vi.hoisted(() => ({ walkingIsochrone: vi.fn() }));
vi.mock("@/lib/providers/ors", () => ({ walkingIsochrone }));

import { ProviderError } from "@/lib/providers/http";

import { GET } from "./route";

const call = (qs: string) => GET(new Request(`http://localhost/api/isochrone${qs}`));

// Braces matter: mockReset() returns the mock, and a function returned from
// beforeEach runs as a TEARDOWN that would call the mock after every test.
beforeEach(() => {
  walkingIsochrone.mockReset();
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

  it("502 + a logged cause when the provider fails", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    walkingIsochrone.mockRejectedValue(new ProviderError("openrouteservice responded 429"));
    expect((await call("?lat=44.4268&lng=26.1025")).status).toBe(502);
    expect(logged).toHaveBeenCalledExactlyOnceWith("[api:isochrone] ProviderError: openrouteservice responded 429");
    logged.mockRestore();
  });
});
