import { beforeEach, describe, expect, it, vi } from "vitest";

const { nearbyAmenities } = vi.hoisted(() => ({ nearbyAmenities: vi.fn() }));
vi.mock("@/features/amenities/server/overpass", () => ({ nearbyAmenities }));

import { ProviderError } from "@/lib/provider-http";

import { GET } from "./route";

const call = (qs: string) => GET(new Request(`http://localhost/api/amenities${qs}`));

beforeEach(() => {
  nearbyAmenities.mockReset();
});

describe("GET /api/amenities", () => {
  it("400 on invalid coords", async () => {
    expect((await call("?lat=abc&lng=26")).status).toBe(400);
  });

  it("400 on blank/absent coords", async () => {
    expect((await call("?lat=&lng=")).status).toBe(400);
    expect((await call("")).status).toBe(400);
  });

  it("422 outside the Bucharest area (no provider call)", async () => {
    expect((await call("?lat=46.77&lng=23.6")).status).toBe(422);
    expect(nearbyAmenities).not.toHaveBeenCalled();
  });

  it("200 + the flat amenities DTO on success", async () => {
    const result = {
      origin: { lat: 44.4268, lng: 26.1025 },
      walkMinutes: 15,
      counts: { groceries: 0, pharmacies: 1, parks: 0, schools: 0, transit: 0 },
      amenities: [{ lat: 44.44, lng: 26.12, name: "Catena", category: "pharmacies" }],
    };
    nearbyAmenities.mockResolvedValue(result);
    const res = await call("?lat=44.4268&lng=26.1025");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(result);
  });

  it("502 + a logged cause when the provider fails", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    nearbyAmenities.mockRejectedValue(new ProviderError("overpass unavailable"));
    expect((await call("?lat=44.4268&lng=26.1025")).status).toBe(502);
    expect(logged).toHaveBeenCalledExactlyOnceWith("[api:amenities] ProviderError: overpass unavailable");
    logged.mockRestore();
  });
});
