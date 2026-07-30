import { beforeEach, describe, expect, it, vi } from "vitest";

const { nearbyAmenities } = vi.hoisted(() => ({ nearbyAmenities: vi.fn() }));
vi.mock("@/features/amenities/server/catalogue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/amenities/server/catalogue")>()),
  nearbyAmenities,
}));

import { CatalogueUnavailableError } from "@/features/amenities/server/catalogue";
import { ProviderError } from "@/lib/provider-http";

import { GET } from "./route";

const call = (qs: string) => GET(new Request(`http://localhost/api/amenities${qs}`));
/** A valid request needs coords AND a mode (task 065: mode is required, not defaulted). */
const ORIGIN = "?lat=44.4268&lng=26.1025&mode=walk";

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
      clip: { mode: "walk", band: 45, minutes: 45 },
      countsByBand: {
        15: { groceries: 0, pharmacies: 1, parks: 0, schools: 0, transit: 0 },
        30: { groceries: 0, pharmacies: 0, parks: 0, schools: 0, transit: 0 },
        45: { groceries: 0, pharmacies: 0, parks: 0, schools: 0, transit: 0 },
      },
      amenities: [{ lat: 44.44, lng: 26.12, name: "Catena", category: "pharmacies", band: 15 }],
      // The real payload always carries `catalogue` (freshness), so the mock must too —
      // otherwise the exact-key assertion below pins a 4-key shape production never
      // returns, and a regression dropping `catalogue` would ship green. Four round-3
      catalogue: { sourceTimestamp: "2026-07-26T03:03:36.000Z", stale: false },
    };
    nearbyAmenities.mockResolvedValue(result);
    const res = await call(ORIGIN);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(result);
    // The route forwards the service result verbatim, so this only proves the ROUTE adds
    // nothing and drops nothing. The real contract — that `nearbyAmenities` itself no
    // longer emits a flat `counts` — is asserted against production output in
    // `catalogue.test.ts` (a mock-echo assertion here could not catch that).
    expect(Object.keys(body).sort()).toEqual([
      "amenities",
      "catalogue",
      "clip",
      "countsByBand",
      "origin",
    ]);
  });

  it("502 + a logged cause when the provider fails", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    nearbyAmenities.mockRejectedValue(new ProviderError("overpass unavailable"));
    expect((await call(ORIGIN)).status).toBe(502);
    expect(logged).toHaveBeenCalledExactlyOnceWith("[api:amenities] ProviderError: overpass unavailable");
    logged.mockRestore();
  });

  it("400 when `mode` is absent — never a silent walk default (task 065 P10)", async () => {
    // A defaulting mode would let an un-updated client keep the pre-065 behaviour:
    // a 15-minute WALK marker set painted over transit/car shading, with nothing
    // anywhere reporting a problem.
    const res = await call("?lat=44.4268&lng=26.1025");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid mode" });
    expect(nearbyAmenities).not.toHaveBeenCalled();
  });

  it("400 on an unknown mode", async () => {
    expect((await call("?lat=44.4268&lng=26.1025&mode=teleport")).status).toBe(400);
    expect(nearbyAmenities).not.toHaveBeenCalled();
  });

  it("threads every valid mode through to the clip", async () => {
    for (const mode of ["walk", "transit", "car"] as const) {
      nearbyAmenities.mockReset();
      nearbyAmenities.mockResolvedValue({ amenities: [], countsByBand: {} });
      const res = await call(`?lat=44.4268&lng=26.1025&mode=${mode}`);
      expect(res.status).toBe(200);
      expect(nearbyAmenities).toHaveBeenCalledWith(44.4268, 26.1025, "normal", mode, {
        kind: "preset",
        preset: "crowded",
      });
    }
  });

  it("threads the time preset through, and 400s on a junk or retired one", async () => {
    nearbyAmenities.mockResolvedValue({ amenities: [], countsByBand: {} });
    expect((await call("?lat=44.4268&lng=26.1025&mode=transit&preset=quiet")).status).toBe(200);
    expect(nearbyAmenities).toHaveBeenCalledWith(44.4268, 26.1025, "normal", "transit", {
      kind: "preset",
      preset: "quiet",
    });

    nearbyAmenities.mockReset();
    expect((await call("?lat=44.4268&lng=26.1025&mode=transit&preset=rush")).status).toBe(400);
    // Retired task-059 params must not sneak a departure past the preset contract.
    expect((await call("?lat=44.4268&lng=26.1025&mode=transit&weekday=3&time=08:30")).status).toBe(400);
    expect(nearbyAmenities).not.toHaveBeenCalled();
  });

  it("400 on an invalid pace before any provider work", async () => {
    expect((await call("?lat=44.4268&lng=26.1025&mode=walk&pace=sprint")).status).toBe(400);
    expect(nearbyAmenities).not.toHaveBeenCalled();
  });

  it("503 when the local catalogue is unavailable", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    nearbyAmenities.mockRejectedValue(new CatalogueUnavailableError("No active amenity catalogue"));
    const response = await call(ORIGIN);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Amenity catalogue unavailable" });
    expect(logged).toHaveBeenCalledExactlyOnceWith(
      "[api:amenities] CatalogueUnavailableError: No active amenity catalogue",
    );
    logged.mockRestore();
  });
});
