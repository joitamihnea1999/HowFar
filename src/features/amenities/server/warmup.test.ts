import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const findActiveDataset = vi.fn();
const queryRaw = vi.fn();
const walkingIsochrone = vi.fn();
const drivingIsochrone = vi.fn();

vi.mock("@/lib/db", () => ({
  db: () => ({
    amenityDataset: { findUnique: findActiveDataset },
    $queryRaw: queryRaw,
  }),
}));
vi.mock("@/features/isochrones/server/ors", () => ({ walkingIsochrone, drivingIsochrone }));

const { warmupProviders, __resetWarmupForTest } = await import("./warmup");

describe("warmupProviders (task 017)", () => {
  beforeEach(() => {
    __resetWarmupForTest();
    findActiveDataset.mockReset().mockResolvedValue({ id: "ds-1" });
    queryRaw.mockReset().mockResolvedValue([{ n: 1 }]);
    walkingIsochrone.mockReset().mockResolvedValue({ origin: {}, rings: [] });
    drivingIsochrone.mockReset().mockResolvedValue({ origin: {}, rings: [] });
  });
  afterEach(() => __resetWarmupForTest());

  it("warms the catalogue buffer and both ORS profiles once", async () => {
    await warmupProviders();
    expect(findActiveDataset).toHaveBeenCalledTimes(1);
    expect(queryRaw).toHaveBeenCalledTimes(1); // the geom-buffer read
    expect(walkingIsochrone).toHaveBeenCalledTimes(1);
    expect(drivingIsochrone).toHaveBeenCalledTimes(1);
  });

  it("is single-flight: a second call does NOT re-invoke the providers (never a thundering herd)", async () => {
    await warmupProviders();
    await warmupProviders();
    await warmupProviders();
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(walkingIsochrone).toHaveBeenCalledTimes(1);
    expect(drivingIsochrone).toHaveBeenCalledTimes(1);
  });

  it("is single-flight under CONCURRENT calls (two probes at once share one warmup)", async () => {
    await Promise.all([warmupProviders(), warmupProviders()]);
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(walkingIsochrone).toHaveBeenCalledTimes(1);
  });

  it("NEVER throws: a failing provider resolves quietly (readiness/boot must not see it)", async () => {
    walkingIsochrone.mockRejectedValue(new Error("ORS down"));
    drivingIsochrone.mockRejectedValue(new Error("ORS down"));
    await expect(warmupProviders()).resolves.toBeUndefined();
  });

  it("a FAILED warmup is not done-forever: a later call retries (single-flight cleared on failure)", async () => {
    walkingIsochrone.mockRejectedValueOnce(new Error("ORS down")).mockResolvedValue({ origin: {}, rings: [] });
    drivingIsochrone.mockRejectedValueOnce(new Error("ORS down")).mockResolvedValue({ origin: {}, rings: [] });
    await warmupProviders(); // fails (both ORS reject) → promise cleared
    expect(walkingIsochrone).toHaveBeenCalledTimes(1);
    await warmupProviders(); // RETRY — providers now succeed
    expect(walkingIsochrone).toHaveBeenCalledTimes(2);
    await warmupProviders(); // success is cached → no third invocation
    expect(walkingIsochrone).toHaveBeenCalledTimes(2);
  });

  it("NEVER throws: a failing catalogue read resolves quietly", async () => {
    queryRaw.mockRejectedValue(new Error("db down"));
    await expect(warmupProviders()).resolves.toBeUndefined();
  });

  it("no active catalogue ⇒ the geom-buffer read is skipped (no-op), still warms ORS", async () => {
    findActiveDataset.mockResolvedValue(null);
    await warmupProviders();
    expect(queryRaw).not.toHaveBeenCalled();
    expect(walkingIsochrone).toHaveBeenCalledTimes(1);
  });
});
