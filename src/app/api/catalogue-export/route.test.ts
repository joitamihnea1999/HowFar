import { beforeEach, describe, expect, it, vi } from "vitest";

const { exportCataloguePage } = vi.hoisted(() => ({ exportCataloguePage: vi.fn() }));
vi.mock("@/features/amenities/server/catalogue-export", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/amenities/server/catalogue-export")>()),
  exportCataloguePage,
}));

import { GET } from "./route";

const call = (query = "") => GET(new Request(`http://localhost/api/catalogue-export${query}`));

beforeEach(() => {
  exportCataloguePage.mockReset();
});

describe("GET /api/catalogue-export", () => {
  it("validates bounded pagination without touching the database", async () => {
    expect((await call("?limit=0")).status).toBe(400);
    expect((await call("?limit=1001")).status).toBe(400);
    expect((await call("?limit=nope")).status).toBe(400);
    expect((await call("?after=")).status).toBe(400);
    expect((await call(`?after=${"x".repeat(201)}`)).status).toBe(400);
    expect(exportCataloguePage).not.toHaveBeenCalled();
  });

  it("returns a cacheable export page and 503 when no catalogue is active", async () => {
    exportCataloguePage.mockResolvedValue({ type: "FeatureCollection", features: [] });
    const response = await call("?limit=25&after=place-1");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("max-age=3600");
    expect(exportCataloguePage).toHaveBeenCalledWith("place-1", 25);

    exportCataloguePage.mockResolvedValue(null);
    expect((await call()).status).toBe(503);
    expect(exportCataloguePage).toHaveBeenLastCalledWith(null, 500);
  });

  it("fails closed on a database error", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    exportCataloguePage.mockRejectedValue(new Error("offline"));
    expect((await call()).status).toBe(503);
    logged.mockRestore();
  });
});
