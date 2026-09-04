import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import MapPlaceholder from "@/features/map/MapPlaceholder";

// The first-paint placeholder is a PURE inline-SVG texture (no hooks, no network),
// so a static render fully exercises it. The contract: it stands behind the map from
// first paint (never a dark void) and is marked "covered" + `hidden` once the live
// map paints over it.
describe("MapPlaceholder (phone-first first-paint texture)", () => {
  it("renders visible (in the DOM, not hidden) before the live map paints", () => {
    const html = renderToStaticMarkup(<MapPlaceholder hidden={false} />);
    expect(html).toContain('data-testid="map-placeholder"');
    expect(html).toContain('data-map-placeholder="visible"');
    // Not hidden while the live map is still loading — the `hidden` attribute is
    // absent (aria-hidden is always present; assert the real hidden attr instead).
    expect(html).not.toMatch(/(?<!aria-)hidden=""/);
    // A realistic texture, not a flat void: the inline SVG paints streets + water.
    expect(html).toContain("<svg");
    expect(html).toContain('aria-hidden="true"');
  });

  it("is marked covered + hidden once the live map has painted over it", () => {
    const html = renderToStaticMarkup(<MapPlaceholder hidden={true} />);
    expect(html).toContain('data-map-placeholder="covered"');
    // The real `hidden` attribute is now present (distinct from the constant aria-hidden).
    expect(html).toMatch(/(?<!aria-)hidden=""/);
  });
});
