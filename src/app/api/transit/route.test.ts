import { beforeEach, describe, expect, it, vi } from "vitest";

const { transitIsochrone } = vi.hoisted(() => ({ transitIsochrone: vi.fn() }));
vi.mock("@/lib/providers/transit", () => ({ transitIsochrone }));

import { GET } from "./route";

const call = (qs: string) => GET(new Request(`http://localhost/api/transit${qs}`));

beforeEach(() => transitIsochrone.mockReset());

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
  });
  // Provider-error → 502 mapping is covered directly in api-util.test.ts
  // (errorResponse), avoiding a rejecting-mock unhandled-rejection artifact.
});
