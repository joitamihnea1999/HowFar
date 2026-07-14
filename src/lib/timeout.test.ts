import { describe, expect, it } from "vitest";

import { withTimeout } from "./timeout";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("withTimeout", () => {
  it("returns the value when the promise settles inside the deadline", async () => {
    const result = await withTimeout(Promise.resolve(42), 100);
    expect(result).toEqual({ ok: true, value: 42 });
  });

  it("reports a timeout when the promise is slower than the deadline", async () => {
    const slow = sleep(200).then(() => "late");
    const result = await withTimeout(slow, 20);
    expect(result).toEqual({ ok: false, reason: "timeout" });
  });

  it("never throws — a rejecting promise becomes an error result", async () => {
    const boom = new Error("db exploded");
    const result = await withTimeout(Promise.reject(boom), 100);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("error");
      expect(result.error).toBe(boom);
    }
  });

  it("a rejection after the deadline does not surface as unhandled", async () => {
    const lateReject = sleep(50).then(() => {
      throw new Error("too late to matter");
    });
    const result = await withTimeout(lateReject, 10);
    expect(result).toEqual({ ok: false, reason: "timeout" });
    await sleep(80); // if the late rejection were unhandled, Vitest would fail the test
  });
});
