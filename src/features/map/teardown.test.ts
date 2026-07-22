import { describe, expect, it, vi } from "vitest";

import { teardownInOrder } from "./teardown";

describe("teardownInOrder", () => {
  it("runs every disposer in the given order, then removeMap last", () => {
    const order: string[] = [];
    teardownInOrder(
      [() => order.push("selectFlow"), () => order.push("popup"), () => order.push("camera")],
      () => order.push("removeMap"),
    );
    expect(order).toEqual(["selectFlow", "popup", "camera", "removeMap"]);
  });

  it("the map is still present while EVERY disposer runs (removeMap cannot run early)", () => {
    let removed = false;
    const seenRemovedDuringDispose: boolean[] = [];
    teardownInOrder(
      [
        () => seenRemovedDuringDispose.push(removed),
        () => seenRemovedDuringDispose.push(removed),
        () => seenRemovedDuringDispose.push(removed),
      ],
      () => {
        removed = true;
      },
    );
    // No disposer observed a removed map — the invariant a reordering would break.
    expect(seenRemovedDuringDispose).toEqual([false, false, false]);
    expect(removed).toBe(true);
  });

  it("calls removeMap exactly once", () => {
    const removeMap = vi.fn();
    teardownInOrder([() => {}, () => {}], removeMap);
    expect(removeMap).toHaveBeenCalledTimes(1);
  });
});
