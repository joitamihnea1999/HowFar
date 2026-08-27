import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the transaction so the region gate inside withActiveDataset runs against a
// controllable active-pointer read — this pins the "fail-closed by construction"
// guarantee in the UNIT suite (check:ci), not only in the DB integration test.
const { transaction, txFindUnique } = vi.hoisted(() => ({
  transaction: vi.fn(),
  txFindUnique: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: () => ({ $transaction: transaction }) }));

import { withActiveDataset } from "./catalogue-store";

const DEFAULT = { minLng: 25.8, minLat: 44.2, maxLng: 26.4, maxLat: 44.7 };
const OTHER_CITY = { minLng: 23.4, minLat: 46.6, maxLng: 23.7, maxLat: 46.9 };

beforeEach(() => {
  transaction.mockReset();
  txFindUnique.mockReset();
  // Run the callback with a tx whose amenityDataset.findUnique is our stub.
  transaction.mockImplementation((cb: (tx: unknown) => unknown) =>
    cb({ amenityDataset: { findUnique: txFindUnique } }),
  );
});
afterEach(() => vi.restoreAllMocks());

describe("withActiveDataset — region gate (task 013)", () => {
  it("runs the read for a region-matching active dataset, passing the pinned id", async () => {
    txFindUnique.mockResolvedValue({ id: "ds-1", validation: { source: { bbox: DEFAULT } } });
    const read = vi.fn().mockResolvedValue("SERVED");
    await expect(withActiveDataset(read)).resolves.toBe("SERVED");
    expect(read).toHaveBeenCalledWith(expect.anything(), "ds-1");
    // Pin the select: dropping `validation` here would make readValidationBbox see
    // undefined ⇒ grandfather ⇒ silently vacate the authoritative gate.
    expect(txFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ select: expect.objectContaining({ validation: true }) }),
    );
  });

  it("FAILS CLOSED on a region mismatch: returns null and NEVER runs the read", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    txFindUnique.mockResolvedValue({ id: "ds-1", validation: { source: { bbox: OTHER_CITY } } });
    const read = vi.fn().mockResolvedValue("SERVED");
    await expect(withActiveDataset(read)).resolves.toBeNull();
    expect(read).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("does not match the configured extent"));
  });

  it("FAILS CLOSED on malformed region metadata (corrupt validation), read never runs", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    txFindUnique.mockResolvedValue({ id: "ds-1", validation: { source: null } });
    const read = vi.fn();
    await expect(withActiveDataset(read)).resolves.toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it("returns null (no read) when there is no active dataset", async () => {
    txFindUnique.mockResolvedValue(null);
    const read = vi.fn();
    await expect(withActiveDataset(read)).resolves.toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it("grandfathers a legacy (no recorded bbox) active dataset under the default extent", async () => {
    txFindUnique.mockResolvedValue({ id: "ds-legacy", validation: { source: {} } });
    const read = vi.fn().mockResolvedValue("SERVED");
    await expect(withActiveDataset(read)).resolves.toBe("SERVED");
    expect(read).toHaveBeenCalledWith(expect.anything(), "ds-legacy");
  });
});
