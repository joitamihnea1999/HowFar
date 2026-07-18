import { describe, expect, it } from "vitest";

import { cameraPadding, DOCK_BREAKPOINT_PX, DOCK_CAMERA_PAD_LEFT_PX } from "./camera";

describe("cameraPadding", () => {
  it("pads the dock footprint on md+ viewports (flyTo and fitBounds share this)", () => {
    expect(cameraPadding(DOCK_BREAKPOINT_PX)).toEqual({ left: DOCK_CAMERA_PAD_LEFT_PX });
    expect(cameraPadding(1280)).toEqual({ left: DOCK_CAMERA_PAD_LEFT_PX });
  });

  it("pads nothing below md, where controls stack on top instead of docking", () => {
    expect(cameraPadding(DOCK_BREAKPOINT_PX - 1)).toEqual({ left: 0 });
    expect(cameraPadding(390)).toEqual({ left: 0 });
  });
});
