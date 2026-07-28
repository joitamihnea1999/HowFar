import { describe, expect, it } from "vitest";

import { deriveShell, EXPANDED_SHELL, type ShellInputs } from "@/features/map/shell-state";

const base: ShellInputs = {
  isMobile: true,
  selStatus: "idle",
  hasSelection: true,
  userDockOpen: false,
  userSheetExpanded: false,
  reachActive: false,
};

describe("deriveShell", () => {
  it("desktop is always fully expanded, whatever the flags say", () => {
    for (const selStatus of ["idle", "loading", "error"] as const) {
      for (const flags of [true, false]) {
        expect(
          deriveShell({
            isMobile: false,
            selStatus,
            hasSelection: flags,
            userDockOpen: flags,
            userSheetExpanded: flags,
            reachActive: flags,
          }),
        ).toEqual(EXPANDED_SHELL);
      }
    }
  });

  it("collapses the dock only once a selection exists", () => {
    expect(deriveShell({ ...base, hasSelection: false }).dock).toBe("expanded");
    expect(deriveShell(base).dock).toBe("collapsed");
  });

  it("a collapsed dock always has a selection to summarize (no blank pill)", () => {
    // Every input combination that yields "collapsed" implies hasSelection.
    for (const selStatus of ["idle", "loading", "error"] as const) {
      for (const hasSelection of [true, false]) {
        for (const userDockOpen of [true, false]) {
          const out = deriveShell({ ...base, selStatus, hasSelection, userDockOpen });
          if (out.dock === "collapsed") expect(hasSelection).toBe(true);
        }
      }
    }
  });

  it("an error reopens the dock so the message and inputs are reachable", () => {
    expect(deriveShell({ ...base, selStatus: "error" }).dock).toBe("expanded");
  });

  it("a recompute (loading with a preserved selection) stays collapsed — the pill reads live state", () => {
    expect(deriveShell({ ...base, selStatus: "loading" }).dock).toBe("collapsed");
  });

  it("a fresh search (loading, no prior selection) keeps the dock expanded", () => {
    expect(deriveShell({ ...base, selStatus: "loading", hasSelection: false }).dock).toBe("expanded");
  });

  it("the user can reopen the dock from the pill", () => {
    expect(deriveShell({ ...base, userDockOpen: true }).dock).toBe("expanded");
  });

  it("the sheet peeks by default and expands on user request", () => {
    expect(deriveShell(base).sheet).toBe("peek");
    expect(deriveShell({ ...base, userSheetExpanded: true }).sheet).toBe("expanded");
  });

  it("active directions force the sheet expanded (a journey answer never hides behind the peek bar)", () => {
    expect(deriveShell({ ...base, reachActive: true }).sheet).toBe("expanded");
    expect(deriveShell({ ...base, reachActive: true, userSheetExpanded: false }).sheet).toBe("expanded");
  });

  it("an error forces the sheet expanded — the failure message must never hide behind the peek bar", () => {
    expect(deriveShell({ ...base, selStatus: "error" }).sheet).toBe("expanded");
    expect(deriveShell({ ...base, selStatus: "error", hasSelection: false }).sheet).toBe("expanded");
  });
});
