import { NextResponse } from "next/server";
import { describe, expect, it } from "vitest";

import { errorResponse, jsonError, outOfAreaGuard, parseLatLng } from "./api-util";
import { ProviderError } from "./providers/http";

describe("errorResponse", () => {
  it("maps ProviderError → 502", () => {
    expect(errorResponse(new ProviderError("upstream")).status).toBe(502);
  });
  it("maps any other error → 500", () => {
    expect(errorResponse(new Error("boom")).status).toBe(500);
    expect(errorResponse("weird").status).toBe(500);
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
