import { beforeEach, describe, expect, it, vi } from "vitest";

const { routePath } = vi.hoisted(() => ({ routePath: vi.fn() }));
vi.mock("@/features/amenities/server/route-path", () => ({ routePath }));

import { ProviderError } from "@/lib/provider-http";

import { GET } from "./route";

const call = (qs: string) => GET(new Request(`http://localhost/api/route-path${qs}`));

beforeEach(() => {
  routePath.mockReset();
});

describe("GET /api/route-path", () => {
  const inArea = "lat=44.4453&lng=26.0977";

  it("400 on missing/blank lat/lng", async () => {
    expect((await call("?rel=1")).status).toBe(400);
    expect((await call("?rel=1&lat=&lng=")).status).toBe(400);
    expect(routePath).not.toHaveBeenCalled();
  });

  it("422 outside the Bucharest area — with ZERO provider calls (footprint bound)", async () => {
    const res = await call("?rel=1&lat=46.77&lng=23.6"); // Cluj
    expect(res.status).toBe(422);
    expect(routePath).not.toHaveBeenCalled();
  });

  it("400 on a non-positive, non-integer, or missing rel", async () => {
    expect((await call(`?${inArea}`)).status).toBe(400);
    expect((await call(`?rel=0&${inArea}`)).status).toBe(400);
    expect((await call(`?rel=-5&${inArea}`)).status).toBe(400);
    expect((await call(`?rel=1.5&${inArea}`)).status).toBe(400);
    expect((await call(`?rel=abc&${inArea}`)).status).toBe(400);
    expect(routePath).not.toHaveBeenCalled();
  });

  it("200 + the path on success", async () => {
    const path = {
      segments: [
        [
          [26.03, 44.41],
          [26.04, 44.42],
        ],
      ],
      stops: [{ lat: 44.41, lng: 26.03, name: "Brașov" }],
    };
    routePath.mockResolvedValue(path);
    const res = await call(`?rel=412304&${inArea}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(path);
    expect(routePath).toHaveBeenCalledWith(412304);
  });

  it("404 when the relation is not a drawable transit route", async () => {
    routePath.mockResolvedValue(null);
    const res = await call(`?rel=99&${inArea}`);
    expect(res.status).toBe(404);
  });

  it("502 on a provider failure, 500 on an unexpected one", async () => {
    routePath.mockRejectedValueOnce(new ProviderError("overpass unavailable"));
    expect((await call(`?rel=1&${inArea}`)).status).toBe(502);
    routePath.mockRejectedValueOnce(new Error("boom"));
    expect((await call(`?rel=1&${inArea}`)).status).toBe(500);
  });
});
