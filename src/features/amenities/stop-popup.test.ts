import { describe, expect, it } from "vitest";

import { buildStopPopupModel } from "./stop-popup";
import type { StopLine } from "./stop-lines";

describe("buildStopPopupModel", () => {
  it("loading phase → loading model with the title", () => {
    expect(buildStopPopupModel("Piața Romană", "loading")).toEqual({
      kind: "loading",
      title: "Piața Romană",
    });
  });

  it("error phase → error model", () => {
    expect(buildStopPopupModel("Roma", "error")).toEqual({ kind: "error", title: "Roma" });
  });

  it("ready with lines → ready model with mode-labelled rows", () => {
    const lines: StopLine[] = [
      { mode: "bus", ref: "331", direction: "Piața Romană" },
      { mode: "subway", ref: "M2", direction: "Pipera" },
    ];
    expect(buildStopPopupModel("Piața Romană", "ready", lines)).toEqual({
      kind: "ready",
      title: "Piața Romană",
      rows: [
        { modeLabel: "Bus", ref: "331", direction: "Piața Romană" },
        { modeLabel: "Metro", ref: "M2", direction: "Pipera" },
      ],
    });
  });

  it("ready with a directionless line → row omits direction (never invented)", () => {
    const [row] = (buildStopPopupModel("s", "ready", [{ mode: "bus", ref: "104" }]) as {
      rows: unknown[];
    }).rows;
    expect(row).toEqual({ modeLabel: "Bus", ref: "104" });
    expect(row).not.toHaveProperty("direction");
  });

  it("ready with NO lines → empty model (honest 'no data', not a broken popup)", () => {
    expect(buildStopPopupModel("Lonely Stop", "ready", [])).toEqual({ kind: "empty", title: "Lonely Stop" });
    expect(buildStopPopupModel("Lonely Stop", "ready")).toEqual({ kind: "empty", title: "Lonely Stop" });
  });

  it("falls back to a generic title when the name is blank", () => {
    expect(buildStopPopupModel("   ", "loading")).toEqual({ kind: "loading", title: "Transit stop" });
  });
});
