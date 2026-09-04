import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import RingHint from "@/features/map/RingHint";

// RingHint reads its persisted-dismissal state AFTER mount (localStorage has no SSR
// equivalent, and reading it during render would hydration-mismatch a dismissed
// user). So the FIRST paint — the server render, before any client effect runs —
// must render NOTHING: `dismissed` starts `null` ("not yet known"), and the guard
// `!active || dismissed !== false` short-circuits to null. This is the "no flash
// for returning users" contract; the live/dismiss behaviour is exercised in the
// mobile e2e (ui-mobile.spec.ts), which runs a real browser with localStorage.
describe("RingHint (mobile peek hint — first-paint guard)", () => {
  it("renders nothing on first paint when active (dismissal not yet known)", () => {
    const html = renderToStaticMarkup(<RingHint mode="walk" selectedMin={10} active={true} />);
    expect(html).toBe("");
  });

  it("renders nothing when inactive", () => {
    const html = renderToStaticMarkup(<RingHint mode="transit" selectedMin={20} active={false} />);
    expect(html).toBe("");
  });
});
