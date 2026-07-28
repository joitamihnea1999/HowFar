import { describe, expect, it } from "vitest";
import type maplibregl from "maplibre-gl";

import { createCameraController } from "@/features/map/camera-controller";
import { MOBILE_CAMERA_PAD_TOP_COLLAPSED_PX, MOBILE_CAMERA_PAD_TOP_PX } from "@/features/map/camera";
import type { ShellState } from "@/features/map/shell-state";

/** Minimal fake map: records setPadding calls, replays moveend once. */
function fakeMap({ moving = false }: { moving?: boolean } = {}) {
  const paddings: { top: number; right: number; bottom: number; left: number }[] = [];
  let moveendCb: (() => void) | null = null;
  const map = {
    setPadding(p: { top: number; right: number; bottom: number; left: number }) {
      paddings.push(p);
    },
    getPadding() {
      return paddings[paddings.length - 1];
    },
    isMoving: () => moving,
    once(event: string, cb: () => void) {
      if (event === "moveend") moveendCb = cb;
    },
  };
  return {
    map: map as unknown as maplibregl.Map,
    paddings,
    settle() {
      moving = false;
      moveendCb?.();
      moveendCb = null;
    },
  };
}

// Node test env (no DOM): the controller reads clientWidth/clientHeight and
// writes dataset read-back stamps — a plain object covers both.
function el(width = 390, height = 844): HTMLElement {
  return { clientWidth: width, clientHeight: height, dataset: {} } as unknown as HTMLElement;
}

describe("createCameraController shell wiring", () => {
  it("consults the shell getter at CALL time, not construction time", () => {
    // The selection flow mutates the shell refs (dock collapse) immediately
    // before renderSelection re-commits padding — the controller must see that
    // fresh value, which is the plan-panel ordering contract.
    let shell: ShellState = { dock: "expanded", sheet: "expanded" };
    const { map, paddings } = fakeMap();
    const camera = createCameraController({ map, el: el(), shell: () => shell });

    camera.applyCameraPadding(true);
    expect(paddings[0].top).toBe(MOBILE_CAMERA_PAD_TOP_PX);

    shell = { dock: "collapsed", sheet: "peek" };
    camera.applyCameraPadding(true);
    expect(paddings[1].top).toBe(MOBILE_CAMERA_PAD_TOP_COLLAPSED_PX);
  });

  it("applyCameraPaddingSafe applies immediately when the camera is at rest", () => {
    const { map, paddings } = fakeMap({ moving: false });
    const camera = createCameraController({ map, el: el() });
    camera.applyCameraPaddingSafe(true);
    expect(paddings).toHaveLength(1);
  });

  it("applyCameraPaddingSafe defers to moveend while an animation is in flight (setPadding would stop() it)", () => {
    const fake = fakeMap({ moving: true });
    const camera = createCameraController({ map: fake.map, el: el() });
    camera.applyCameraPaddingSafe(true);
    expect(fake.paddings).toHaveLength(0); // nothing committed mid-flight
    fake.settle();
    expect(fake.paddings).toHaveLength(1); // committed once the camera settled
  });

  it("coalesces queued deferred flips to the LAST requested value", () => {
    const fake = fakeMap({ moving: true });
    let shell: ShellState = { dock: "expanded", sheet: "expanded" };
    const camera = createCameraController({ map: fake.map, el: el(), shell: () => shell });
    camera.applyCameraPaddingSafe(true);
    shell = { dock: "collapsed", sheet: "peek" };
    camera.applyCameraPaddingSafe(true);
    fake.settle();
    expect(fake.paddings).toHaveLength(1);
    expect(fake.paddings[0].top).toBe(MOBILE_CAMERA_PAD_TOP_COLLAPSED_PX);
  });
});
