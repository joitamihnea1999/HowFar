import { beforeEach, describe, expect, it, vi } from "vitest";

const { getCatalogueStatus } = vi.hoisted(() => ({ getCatalogueStatus: vi.fn() }));
vi.mock("@/features/amenities/server/catalogue-status", () => ({ getCatalogueStatus }));

import { GET } from "./route";

beforeEach(() => {
  getCatalogueStatus.mockReset();
});

describe("GET /api/catalogue-status", () => {
  it("is 200 only for a fresh active catalogue", async () => {
    getCatalogueStatus.mockResolvedValue({ available: true, stale: false, placeCount: 10 });
    expect((await GET()).status).toBe(200);
    getCatalogueStatus.mockResolvedValue({ available: true, stale: true, placeCount: 10 });
    expect((await GET()).status).toBe(503);
  });

  it("fails closed when the status query throws", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    getCatalogueStatus.mockRejectedValue(new Error("database offline"));
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ available: false, stale: true });
    logged.mockRestore();
  });
});
