import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  failureMessage,
  GENERIC_ERROR,
  initialSelectionState,
  isochronePath,
  isochroneUrl,
  modeWord,
  reverseIsFatal,
  sameTimeContext,
  selectionReducer,
  type SelectionAction,
  type SelectionState,
} from "./selection-flow";

const ORIGIN = { lat: 44.4268, lng: 26.1025 };

function start(mode: "walk" | "transit" = "walk", from: SelectionState = initialSelectionState) {
  return selectionReducer(from, { type: "start", mode });
}

describe("selectionReducer — token accept/reject", () => {
  it("start bumps the token, enters loading, and forgets the prior selection", () => {
    const resolved = selectionReducer(start(), { type: "resolved", token: 1, origin: ORIGIN, label: "A" });
    expect(resolved.lastSelection).not.toBeNull();
    const restarted = selectionReducer(resolved, { type: "start", mode: "walk" });
    expect(restarted.token).toBe(2);
    expect(restarted.status).toBe("loading");
    expect(restarted.label).toBeNull();
    expect(restarted.message).toBeNull();
    expect(restarted.lastSelection).toBeNull();
  });

  it("start with preserveLast keeps the prior origin (toggle-recompute path); default clears it", () => {
    const resolved = selectionReducer(start(), { type: "resolved", token: 1, origin: ORIGIN, label: "A" });
    expect(resolved.lastSelection).toEqual({ lat: ORIGIN.lat, lng: ORIGIN.lng, label: "A" });
    // A genuinely-new selection clears it…
    expect(selectionReducer(resolved, { type: "start", mode: "walk" }).lastSelection).toBeNull();
    // …but a recompute preserves it so a further toggle can still recover the origin.
    const recompute = selectionReducer(resolved, { type: "start", mode: "transit", preserveLast: true });
    expect(recompute.lastSelection).toEqual(resolved.lastSelection);
    expect(recompute.status).toBe("loading");
    expect(recompute.mode).toBe("transit");
  });

  it("accepts a resolved carrying the current token", () => {
    const s = start(); // token 1
    const resolved = selectionReducer(s, { type: "resolved", token: 1, origin: ORIGIN, label: "Piața Unirii" });
    expect(resolved.status).toBe("idle");
    expect(resolved.label).toBe("Piața Unirii");
    expect(resolved.lastSelection).toEqual({ lat: ORIGIN.lat, lng: ORIGIN.lng, label: "Piața Unirii" });
  });

  it("ignores a resolved with a stale token (returns the SAME state ref)", () => {
    const s1 = start(); // token 1
    const s2 = selectionReducer(s1, { type: "start", mode: "walk" }); // token 2
    const out = selectionReducer(s2, { type: "resolved", token: 1, origin: ORIGIN, label: "stale" });
    expect(out).toBe(s2); // no state change → the component won't paint stale rings
  });

  it("ignores a failed with a stale token (same ref)", () => {
    const s1 = start(); // token 1
    const s2 = selectionReducer(s1, { type: "start", mode: "walk" }); // token 2
    expect(selectionReducer(s2, { type: "failed", token: 1, stage: "geocode", httpStatus: 500 })).toBe(s2);
  });

  it("crash sets the generic error for the current token, and is ignored when stale", () => {
    const s = start(); // token 1
    const crashed = selectionReducer(s, { type: "crash", token: 1 });
    expect(crashed.status).toBe("error");
    expect(crashed.message).toBe(GENERIC_ERROR);
    const s2 = selectionReducer(s, { type: "start", mode: "walk" }); // token 2
    expect(selectionReducer(s2, { type: "crash", token: 1 })).toBe(s2);
  });
});

describe("selectionReducer — mode snapshot & toggle", () => {
  it("toggle bumps the token so a pre-toggle response is then rejected", () => {
    const s = start("walk"); // token 1, loading
    // user has a resolved selection so toggle recomputes rather than resets
    const resolved = selectionReducer(s, { type: "resolved", token: 1, origin: ORIGIN, label: "A" });
    const toggled = selectionReducer(resolved, { type: "toggle", next: "transit" });
    expect(toggled.token).toBe(2);
    expect(toggled.mode).toBe("transit");
    expect(toggled.lastSelection).toEqual(resolved.lastSelection); // preserved for re-issue
    // A response from the pre-toggle request (token 1) is now stale.
    expect(selectionReducer(toggled, { type: "resolved", token: 1, origin: ORIGIN, label: "old" })).toBe(toggled);
  });

  it("failure copy uses the mode captured at the accepted request (snapshot)", () => {
    // start(walk) → toggle(transit) invalidates token 1; a failed on the OLD
    // token is ignored, and a failed on the current token uses transit copy.
    const walk = start("walk"); // token 1
    const resolved = selectionReducer(walk, { type: "resolved", token: 1, origin: ORIGIN, label: "A" });
    const transit = selectionReducer(resolved, { type: "toggle", next: "transit" }); // token 2, mode transit
    expect(selectionReducer(transit, { type: "failed", token: 1, stage: "isochrone", httpStatus: 502 })).toBe(
      transit,
    );
    const failed = selectionReducer(transit, { type: "failed", token: 2, stage: "isochrone", httpStatus: 502 });
    expect(failed.message).toBe("Could not compute transit reach. Try again.");
  });

  it("toggling with no prior selection resets to idle (does not strand loading)", () => {
    const loading = start("walk"); // token 1, loading, lastSelection null
    const toggled = selectionReducer(loading, { type: "toggle", next: "transit" });
    expect(toggled.status).toBe("idle");
    expect(toggled.message).toBeNull();
    expect(toggled.mode).toBe("transit");
    expect(toggled.token).toBe(2);
    expect(toggled.lastSelection).toBeNull();
  });

  it("toggling to the same mode is a no-op (same ref)", () => {
    const s = start("walk");
    expect(selectionReducer(s, { type: "toggle", next: "walk" })).toBe(s);
  });

  it("a failed selection followed by a new resolve clears the stale error message", () => {
    const failed = selectionReducer(start(), { type: "failed", token: 1, stage: "geocode", httpStatus: 404 });
    expect(failed.status).toBe("error");
    expect(failed.message).toBe("No place found there.");
    const restart = selectionReducer(failed, { type: "start", mode: "walk" }); // token 2
    expect(restart.message).toBeNull();
    const ok = selectionReducer(restart, { type: "resolved", token: 2, origin: ORIGIN, label: "B" });
    expect(ok.status).toBe("idle");
    expect(ok.message).toBeNull();
    expect(ok.label).toBe("B");
  });

  it("double-toggle mid-recompute keeps the origin recoverable (B1 fix)", () => {
    // resolved(walk) → toggle(transit) → switchMode recomputes with preserveLast →
    // user toggles back to walk BEFORE the transit recompute resolves.
    const resolved = selectionReducer(start("walk"), { type: "resolved", token: 1, origin: ORIGIN, label: "A" });
    const toTransit = selectionReducer(resolved, { type: "toggle", next: "transit" }); // token 2
    const recompute = selectionReducer(toTransit, { type: "start", mode: "transit", preserveLast: true }); // token 3
    // Origin survives the in-flight recompute now (the bug was it went null here).
    expect(recompute.lastSelection).toEqual({ lat: ORIGIN.lat, lng: ORIGIN.lng, label: "A" });
    const backToWalk = selectionReducer(recompute, { type: "toggle", next: "walk" }); // token 4
    // Still recoverable → switchMode can re-issue the walk recompute (not stranded at idle).
    expect(backToWalk.lastSelection).toEqual({ lat: ORIGIN.lat, lng: ORIGIN.lng, label: "A" });
    const walkAgain = selectionReducer(backToWalk, { type: "start", mode: "walk", preserveLast: true }); // token 5
    const done = selectionReducer(walkAgain, { type: "resolved", token: 5, origin: ORIGIN, label: "A" });
    expect(done.mode).toBe("walk");
    expect(done.lastSelection).toEqual({ lat: ORIGIN.lat, lng: ORIGIN.lng, label: "A" });
  });

  it("a FAILED recompute keeps the origin so the opposite mode can still recover it (B1 fail-path)", () => {
    const resolved = selectionReducer(start("walk"), { type: "resolved", token: 1, origin: ORIGIN, label: "A" });
    const toTransit = selectionReducer(resolved, { type: "toggle", next: "transit" }); // token 2
    const recompute = selectionReducer(toTransit, { type: "start", mode: "transit", preserveLast: true }); // token 3
    // Transit recompute FAILS (502) — must NOT wipe the origin.
    const failed = selectionReducer(recompute, { type: "failed", token: 3, stage: "isochrone", httpStatus: 502 });
    expect(failed.status).toBe("error");
    expect(failed.lastSelection).toEqual({ lat: ORIGIN.lat, lng: ORIGIN.lng, label: "A" });
    // Same for an unexpected crash.
    const crashed = selectionReducer(recompute, { type: "crash", token: 3 });
    expect(crashed.lastSelection).toEqual({ lat: ORIGIN.lat, lng: ORIGIN.lng, label: "A" });
    // Toggling back to walk can still recompute from the preserved origin.
    const backToWalk = selectionReducer(failed, { type: "toggle", next: "walk" });
    expect(backToWalk.lastSelection).toEqual({ lat: ORIGIN.lat, lng: ORIGIN.lng, label: "A" });
  });
});

describe("selectionReducer — token monotonicity (property)", () => {
  it("the token never decreases and every accepted resolve carries the current token", () => {
    const actionArb: fc.Arbitrary<SelectionAction> = fc.oneof(
      fc.constant<SelectionAction>({ type: "start", mode: "walk" }),
      fc.constant<SelectionAction>({ type: "start", mode: "transit" }),
      fc.constant<SelectionAction>({ type: "toggle", next: "walk" }),
      fc.constant<SelectionAction>({ type: "toggle", next: "transit" }),
      // resolved/failed carry a token chosen (below) relative to the live one.
      fc.constant<SelectionAction>({ type: "resolved", token: -1, origin: ORIGIN, label: "x" }),
      fc.constant<SelectionAction>({ type: "failed", token: -1, stage: "isochrone", httpStatus: 502 }),
      fc.constant<SelectionAction>({ type: "crash", token: -1 }),
    );
    fc.assert(
      fc.property(fc.array(actionArb, { maxLength: 60 }), fc.array(fc.boolean(), { minLength: 60 }), (actions, fresh) => {
        let state = initialSelectionState;
        actions.forEach((raw, i) => {
          const prevToken = state.token;
          // For resolved/failed/crash, either target the live token (fresh) or a stale one.
          const action =
            "token" in raw ? { ...raw, token: fresh[i] ? state.token : state.token - 1 } : raw;
          const next = selectionReducer(state, action);
          // Token is monotonic non-decreasing.
          if (next.token < prevToken) throw new Error("token decreased");
          // An accepted resolve/failed/crash never advances the token.
          if ("token" in action && action.token === prevToken && next.token !== prevToken) {
            throw new Error("accepted response changed the token");
          }
          state = next;
        });
        return true;
      }),
    );
  });
});

describe("failureMessage", () => {
  it("maps every fatal stage/status to the current copy", () => {
    expect(failureMessage("geocode", 404, "walk")).toBe("No place found there.");
    expect(failureMessage("geocode", 422, "walk")).toBe("That spot is outside Bucharest.");
    expect(failureMessage("geocode", 500, "walk")).toBe("Could not look that up. Try again.");
    expect(failureMessage("reverse", 422, "walk")).toBe("That spot is outside Bucharest.");
    expect(failureMessage("isochrone", 422, "transit")).toBe("That spot is outside Bucharest.");
    expect(failureMessage("isochrone", 502, "walk")).toBe("Could not compute walking reach. Try again.");
    expect(failureMessage("isochrone", 502, "transit")).toBe("Could not compute transit reach. Try again.");
    // 404 on a non-geocode stage is not the "no place" copy.
    expect(failureMessage("isochrone", 404, "walk")).toBe("Could not compute walking reach. Try again.");
  });
});

describe("pure helpers", () => {
  it("modeWord / isochronePath key off the mode", () => {
    expect(modeWord("walk")).toBe("walking");
    expect(modeWord("transit")).toBe("transit");
    expect(isochronePath("walk")).toBe("/api/isochrone");
    expect(isochronePath("transit")).toBe("/api/transit");
  });

  it("reverseIsFatal is true only for the out-of-area 422", () => {
    expect(reverseIsFatal(422)).toBe(true);
    expect(reverseIsFatal(404)).toBe(false);
    expect(reverseIsFatal(500)).toBe(false);
    expect(reverseIsFatal(200)).toBe(false);
  });

  it("exposes the generic catch-all copy", () => {
    expect(GENERIC_ERROR).toBe("Something went wrong. Try again.");
  });
});

describe("selectionReducer — setPace / setTimeContext (task 051)", () => {
  it("defaults are normal pace + weekday-morning preset (byte-identical baseline)", () => {
    expect(initialSelectionState.pace).toBe("normal");
    expect(initialSelectionState.timeContext).toEqual({ kind: "preset", preset: "weekday-morning" });
  });

  it("setPace bumps the token (drops in-flight) and snapshots the pace", () => {
    const resolved = selectionReducer(start(), { type: "resolved", token: 1, origin: ORIGIN, label: "X" });
    const next = selectionReducer(resolved, { type: "setPace", pace: "brisk" });
    expect(next.pace).toBe("brisk");
    expect(next.token).toBe(resolved.token + 1);
    // a pre-change response is now stale
    expect(selectionReducer(next, { type: "resolved", token: resolved.token, origin: ORIGIN, label: "stale" })).toBe(next);
  });

  it("setPace to the SAME pace is a no-op (no wasted recompute/fetch)", () => {
    const s = start();
    expect(selectionReducer(s, { type: "setPace", pace: "normal" })).toBe(s);
  });

  it("a pace change mid-first-load (loading, no lastSelection) stays loading and is NOT lost", () => {
    const loading = start(); // status loading, lastSelection null
    const next = selectionReducer(loading, { type: "setPace", pace: "relaxed" });
    expect(next.pace).toBe("relaxed");
    expect(next.token).toBe(loading.token + 1); // controller re-issues pending input
    expect(next.status).toBe("loading");
  });

  it("a pace change while idle with no selection goes idle (nothing to recompute)", () => {
    const next = selectionReducer(initialSelectionState, { type: "setPace", pace: "brisk" });
    expect(next.status).toBe("idle");
  });

  it("setTimeContext bumps the token and stores the context; same context is a no-op", () => {
    const resolved = selectionReducer(start("transit"), { type: "resolved", token: 1, origin: ORIGIN, label: "X" });
    const custom = { kind: "custom" as const, weekday: 6, hour: 9, minute: 30 };
    const next = selectionReducer(resolved, { type: "setTimeContext", timeContext: custom });
    expect(next.timeContext).toEqual(custom);
    expect(next.token).toBe(resolved.token + 1);
    expect(selectionReducer(next, { type: "setTimeContext", timeContext: custom })).toBe(next); // no-op
  });

  it("resolved carries the transit departure; a walk resolve clears it", () => {
    const s = selectionReducer(start("transit"), {
      type: "resolved",
      token: 1,
      origin: ORIGIN,
      label: "X",
      departure: { iso: "2026-07-29T05:30:00.000Z", summary: "Weekday morning" },
    });
    expect(s.departure).toEqual({ iso: "2026-07-29T05:30:00.000Z", summary: "Weekday morning" });
    const walk = selectionReducer(start("walk"), { type: "resolved", token: 1, origin: ORIGIN, label: "X" });
    expect(walk.departure).toBeNull();
  });
});

describe("sameTimeContext", () => {
  it("compares presets and custom fields", () => {
    expect(sameTimeContext({ kind: "preset", preset: "midday" }, { kind: "preset", preset: "midday" })).toBe(true);
    expect(sameTimeContext({ kind: "preset", preset: "midday" }, { kind: "preset", preset: "evening" })).toBe(false);
    expect(sameTimeContext({ kind: "custom", weekday: 6, hour: 9, minute: 30 }, { kind: "custom", weekday: 6, hour: 9, minute: 30 })).toBe(true);
    expect(sameTimeContext({ kind: "custom", weekday: 6, hour: 9, minute: 30 }, { kind: "custom", weekday: 6, hour: 9, minute: 0 })).toBe(false);
    expect(sameTimeContext({ kind: "preset", preset: "weekend" }, { kind: "custom", weekday: 6, hour: 12, minute: 0 })).toBe(false);
  });
});

describe("isochroneUrl (task 051 query contract)", () => {
  it("walk carries only pace", () => {
    expect(isochroneUrl("walk", ORIGIN, "brisk", { kind: "preset", preset: "weekday-morning" })).toBe(
      "/api/isochrone?lat=44.4268&lng=26.1025&pace=brisk",
    );
  });
  it("transit preset adds &preset", () => {
    expect(isochroneUrl("transit", ORIGIN, "normal", { kind: "preset", preset: "evening" })).toBe(
      "/api/transit?lat=44.4268&lng=26.1025&pace=normal&preset=evening",
    );
  });
  it("transit custom adds &weekday&time (URL-encoded colon, zero-padded)", () => {
    expect(isochroneUrl("transit", ORIGIN, "relaxed", { kind: "custom", weekday: 6, hour: 9, minute: 0 })).toBe(
      "/api/transit?lat=44.4268&lng=26.1025&pace=relaxed&weekday=6&time=09%3A00",
    );
  });
});
