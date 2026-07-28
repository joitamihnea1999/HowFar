import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import StatePill from "@/features/map/StatePill";

// Static server render — the pill is pure presentation over its props, so the
// emitted markup IS its contract (no DOM library needed in the node test env).
describe("StatePill", () => {
  it("summarizes address, mode, and a minute budget, and offers the expand affordance", () => {
    const html = renderToStaticMarkup(
      <StatePill label="Bulevardul Unirii 10" mode="transit" ringFilter={30} loading={false} onExpand={() => {}} />,
    );
    expect(html).toContain("Bulevardul Unirii 10");
    expect(html).toContain("Public transport");
    expect(html).toContain("30 min");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Change address, travel mode, or time budget");
    expect(html).not.toContain("animate-pulse");
  });

  it('renders "All rings" for the all filter and mode-correct minutes otherwise (car bands differ)', () => {
    const all = renderToStaticMarkup(
      <StatePill label="X" mode="walk" ringFilter="all" loading={false} onExpand={() => {}} />,
    );
    expect(all).toContain("All rings");
    // Car band 45 displays its own minute mapping, not the positional band id.
    const car = renderToStaticMarkup(
      <StatePill label="X" mode="car" ringFilter={45} loading={false} onExpand={() => {}} />,
    );
    expect(car).toContain("30 min");
  });

  it("shows the recompute pulse while loading — the pill stays live, never blank", () => {
    const html = renderToStaticMarkup(
      <StatePill label="X" mode="walk" ringFilter={15} loading={true} onExpand={() => {}} />,
    );
    expect(html).toContain("animate-pulse");
    expect(html).toContain("X");
  });
});
