import { beforeEach, describe, expect, it, vi } from "vitest";

const { stopLines } = vi.hoisted(() => ({ stopLines: vi.fn() }));
vi.mock("@/features/amenities/server/stop-lines", () => ({ stopLines }));

import { ProviderError } from "@/lib/provider-http";

import { GET } from "./route";

const call = (qs: string) => GET(new Request(`http://localhost/api/stop-lines${qs}`));

beforeEach(() => {
  stopLines.mockReset();
});

describe("GET /api/stop-lines", () => {
  const inArea = "lat=44.4453&lng=26.0977";

  it("400 on missing/blank lat/lng", async () => {
    expect((await call("?type=node&id=1")).status).toBe(400);
    expect((await call("?type=node&id=1&lat=&lng=")).status).toBe(400);
    expect(stopLines).not.toHaveBeenCalled();
  });

  it("422 outside the Bucharest area — with ZERO provider calls (footprint bound)", async () => {
    const res = await call("?type=node&id=1&lat=46.77&lng=23.6"); // Cluj
    expect(res.status).toBe(422);
    expect(stopLines).not.toHaveBeenCalled();
  });

  it("400 on a bad or missing OSM type, without calling the provider", async () => {
    expect((await call(`?id=1&${inArea}`)).status).toBe(400);
    expect((await call(`?type=chunk&id=1&${inArea}`)).status).toBe(400);
    expect(stopLines).not.toHaveBeenCalled();
  });

  it("400 on a non-positive, non-integer, or missing id", async () => {
    expect((await call(`?type=node&${inArea}`)).status).toBe(400);
    expect((await call(`?type=node&id=0&${inArea}`)).status).toBe(400);
    expect((await call(`?type=node&id=-5&${inArea}`)).status).toBe(400);
    expect((await call(`?type=node&id=1.5&${inArea}`)).status).toBe(400);
    expect((await call(`?type=node&id=abc&${inArea}`)).status).toBe(400);
    expect(stopLines).not.toHaveBeenCalled();
  });

  it("200 + {name, lines} on success, echoing the client's name", async () => {
    // relationId rides through untouched (task 024: the client draws paths by it).
    const lines = [{ mode: "subway", ref: "M2", direction: "Pipera", relationId: 2947020 }];
    stopLines.mockResolvedValue(lines);
    const res = await call(`?type=node&id=582555685&${inArea}&name=Pia%C8%9Ba%20Roman%C4%83`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "Piața Romană", lines });
    expect(stopLines).toHaveBeenCalledWith("node", 582555685);
  });

  it("200 + empty lines for a stop that serves no mapped routes", async () => {
    stopLines.mockResolvedValue([]);
    const res = await call(`?type=node&id=999&${inArea}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "", lines: [] });
  });

  it("502 + a logged cause when the provider fails", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    stopLines.mockRejectedValue(new ProviderError("overpass unavailable"));
    expect((await call(`?type=node&id=1&${inArea}`)).status).toBe(502);
    expect(logged).toHaveBeenCalledExactlyOnceWith("[api:stop-lines] ProviderError: overpass unavailable");
    logged.mockRestore();
  });
});
