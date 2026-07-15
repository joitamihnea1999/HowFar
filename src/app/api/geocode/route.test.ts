import { beforeEach, describe, expect, it, vi } from "vitest";

const { geocode } = vi.hoisted(() => ({ geocode: vi.fn() }));
vi.mock("@/lib/providers/nominatim", () => ({ geocode }));

import { GET } from "./route";

const call = (q?: string) =>
  GET(new Request(`http://localhost/api/geocode${q === undefined ? "" : `?q=${encodeURIComponent(q)}`}`));

beforeEach(() => geocode.mockReset());

describe("GET /api/geocode", () => {
  it("400 when q is missing", async () => {
    expect((await call()).status).toBe(400);
  });

  it("200 + point for an in-area match", async () => {
    geocode.mockResolvedValue({ lat: 44.4268, lng: 26.1025, label: "Piața Unirii" });
    const res = await call("unirii");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ lat: 44.4268, lng: 26.1025, label: "Piața Unirii" });
  });

  it("404 when there is no match", async () => {
    geocode.mockResolvedValue(null);
    expect((await call("nowhere")).status).toBe(404);
  });

  it("422 when the match is outside the Bucharest area", async () => {
    geocode.mockResolvedValue({ lat: 46.77, lng: 23.6, label: "Cluj-Napoca" });
    expect((await call("cluj")).status).toBe(422);
  });
  // Provider-error → 502 mapping is covered in api-util.test.ts (errorResponse).
});
