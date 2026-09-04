import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import LegendPill from "@/features/map/LegendPill";

// Static server render captures the DEFAULT (collapsed) state — the pill must
// never open expanded (it must not permanently cover the map).
describe("LegendPill (phone-first — slim pill → labeled ramp)", () => {
  it("renders collapsed by default, showing the selected reach ceiling", () => {
    const html = renderToStaticMarkup(<LegendPill mode="walk" selectedMin={20} />);
    expect(html).toContain('data-legend-state="collapsed"');
    expect(html).toContain("≤ 20 min");
    // Collapsed = no full ramp yet (never opens expanded by default).
    expect(html).not.toContain('data-legend-state="expanded"');
  });

  it("names the mode in the accessible label", () => {
    const html = renderToStaticMarkup(<LegendPill mode="transit" selectedMin={40} />);
    expect(html.toLowerCase()).toContain("public transport");
    expect(html).toContain("40 min");
  });
});
