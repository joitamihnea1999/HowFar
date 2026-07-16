import { beforeEach, describe, expect, it, vi } from "vitest";

const { reverseGeocode } = vi.hoisted(() => ({ reverseGeocode: vi.fn() }));
vi.mock("@/lib/providers/nominatim", () => ({ reverseGeocode }));

import { ProviderError } from "@/lib/providers/http";

import { GET } from "./route";

const call = (qs: string) => GET(new Request(`http://localhost/api/reverse${qs}`));

// Braces matter: mockReset() returns the mock, and a function returned from
// beforeEach runs as a TEARDOWN that would call the mock after every test.
beforeEach(() => {
  reverseGeocode.mockReset();
});

describe("GET /api/reverse", () => {
  it("400 when lat/lng are missing or non-numeric", async () => {
    expect((await call("")).status).toBe(400);
    expect((await call("?lat=abc&lng=26")).status).toBe(400);
  });

  it("400 when lat/lng are out of range", async () => {
    expect((await call("?lat=200&lng=26")).status).toBe(400);
  });

  it("422 when the point is outside the Bucharest area", async () => {
    expect((await call("?lat=46.77&lng=23.6")).status).toBe(422);
    expect(reverseGeocode).not.toHaveBeenCalled();
  });

  it("404 when no address is found", async () => {
    reverseGeocode.mockResolvedValue(null);
    expect((await call("?lat=44.4268&lng=26.1025")).status).toBe(404);
  });

  it("200 + point on success", async () => {
    reverseGeocode.mockResolvedValue({ lat: 44.4268, lng: 26.1025, label: "Somewhere" });
    const res = await call("?lat=44.4268&lng=26.1025");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ lat: 44.4268, lng: 26.1025, label: "Somewhere" });
  });

  it("502 + a logged cause when the provider fails", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    reverseGeocode.mockRejectedValue(new ProviderError("nominatim responded 500"));
    expect((await call("?lat=44.4268&lng=26.1025")).status).toBe(502);
    expect(logged).toHaveBeenCalledExactlyOnceWith("[api:reverse] ProviderError: nominatim responded 500");
    logged.mockRestore();
  });
});
