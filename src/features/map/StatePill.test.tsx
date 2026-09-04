import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import StatePill from "@/features/map/StatePill";

// Static server render — the pill is pure presentation over its props, so the
// emitted markup IS its contract (no DOM library needed in the node test env).
describe("StatePill", () => {
  it("summarizes address, mode, and the selected preset minute, and offers the expand affordance", () => {
    const html = renderToStaticMarkup(
      <StatePill label="Bulevardul Unirii 10" mode="transit" selectedMin={40} loading={false} onExpand={() => {}} />,
    );
    expect(html).toContain("Bulevardul Unirii 10");
    expect(html).toContain("Public transport");
    expect(html).toContain("40 min");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Change address, travel mode, or time budget");
    expect(html).not.toContain("animate-pulse");
  });

  it("shows the selected preset minute for each mode (phone-first presets)", () => {
    const walk = renderToStaticMarkup(
      <StatePill label="X" mode="walk" selectedMin={10} loading={false} onExpand={() => {}} />,
    );
    expect(walk).toContain("10 min");
    const car = renderToStaticMarkup(
      <StatePill label="X" mode="car" selectedMin={25} loading={false} onExpand={() => {}} />,
    );
    expect(car).toContain("25 min");
  });

  it("shows the recompute pulse while loading — the pill stays live, never blank", () => {
    const html = renderToStaticMarkup(
      <StatePill label="X" mode="walk" selectedMin={10} loading={true} onExpand={() => {}} />,
    );
    expect(html).toContain("animate-pulse");
    expect(html).toContain("X");
  });
});
