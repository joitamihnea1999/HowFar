import { NextResponse } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { errorResponse, jsonError, outOfAreaGuard, parseLatLng } from "./api-util";
import { ProviderError } from "./providers/http";

describe("errorResponse", () => {
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  afterEach(() => logged.mockClear());

  it("maps ProviderError → 502 and logs route + cause", () => {
    expect(errorResponse(new ProviderError("nominatim responded 503"), "geocode").status).toBe(502);
    expect(logged).toHaveBeenCalledExactlyOnceWith("[api:geocode] ProviderError: nominatim responded 503");
  });
  it("maps any other error → 500, still logged", () => {
    expect(errorResponse(new Error("boom"), "transit").status).toBe(500);
    expect(errorResponse("weird", "transit").status).toBe(500);
    expect(logged).toHaveBeenNthCalledWith(1, "[api:transit] Error: boom");
    expect(logged).toHaveBeenNthCalledWith(2, "[api:transit] Error: weird");
  });
  it("logs one line — name + message only, no stack or payload", () => {
    errorResponse(new ProviderError("openrouteservice responded 429"), "isochrone");
    expect(logged.mock.calls[0]?.[0]).not.toMatch(/\n/);
  });
});

describe("jsonError", () => {
  it("returns the given status with an { error } body", async () => {
    const res = jsonError(404, "nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "nope" });
  });
});

describe("parseLatLng", () => {
  const url = (qs: string) => new URL(`http://localhost/api/x${qs}`);

  it("parses valid coords", () => {
    expect(parseLatLng(url("?lat=44.4268&lng=26.1025"))).toEqual({ lat: 44.4268, lng: 26.1025 });
  });
  it("400 on missing/non-numeric", () => {
    expect(parseLatLng(url("")) instanceof NextResponse).toBe(true);
    expect(parseLatLng(url("?lat=abc&lng=26")) instanceof NextResponse).toBe(true);
  });
  it("400 on out-of-range", () => {
    const res = parseLatLng(url("?lat=200&lng=26"));
    expect(res instanceof NextResponse && res.status).toBe(400);
  });
});

describe("outOfAreaGuard", () => {
  it("null inside Bucharest", () => {
    expect(outOfAreaGuard(44.4268, 26.1025)).toBeNull();
  });
  it("422 outside Bucharest", () => {
    expect(outOfAreaGuard(46.77, 23.6)?.status).toBe(422);
  });
});
