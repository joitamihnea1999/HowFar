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

  it("rows carry relationId when the line has one (selectable → path drawable, task 024)", () => {
    const model = buildStopPopupModel("s", "ready", [
      { mode: "bus", ref: "301", direction: "Piața Romană", relationId: 1766705 },
      { mode: "bus", ref: "104" }, // no id → plain informational row
    ]) as unknown as { rows: Record<string, unknown>[] };
    expect(model.rows[0]).toEqual({
      modeLabel: "Bus",
      ref: "301",
      direction: "Piața Romană",
      relationId: 1766705,
    });
    expect(model.rows[1]).not.toHaveProperty("relationId");
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

  it("flags a partial union (task 047) only when rows exist and partial is set", () => {
    const lines: StopLine[] = [{ mode: "bus", ref: "1" }];
    const full = buildStopPopupModel("Merged", "ready", lines, false);
    expect(full).toEqual({ kind: "ready", title: "Merged", rows: [{ modeLabel: "Bus", ref: "1" }] });
    expect(full).not.toHaveProperty("partial");

    const partial = buildStopPopupModel("Merged", "ready", lines, true);
    expect(partial).toMatchObject({ kind: "ready", partial: true });

    // a partial merge that yielded ZERO rows can't honestly claim "no data" — a
    // failed member may have lines — so it degrades to error, not empty (F3).
    expect(buildStopPopupModel("Merged", "ready", [], true)).toEqual({ kind: "error", title: "Merged" });
    // a COMPLETE result with zero rows is still the honest empty state
    expect(buildStopPopupModel("Merged", "ready", [], false)).toEqual({ kind: "empty", title: "Merged" });
  });
});
