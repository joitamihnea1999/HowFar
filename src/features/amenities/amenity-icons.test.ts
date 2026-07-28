import { describe, expect, it } from "vitest";

import { AMENITY_CATEGORIES, type AmenityCategoryKey } from "@/features/amenities/amenities";

import {
  AMENITY_ICONS,
  amenityIconImageExpression,
  amenityIconImageId,
  amenityIconSvg,
  ICON_VIEWBOX,
} from "./amenity-icons";

const KEYS = AMENITY_CATEGORIES.map((c) => c.key);

describe("AMENITY_ICONS", () => {
  it("covers EVERY category — a missing icon must be impossible, not a blank pin", () => {
    // The exhaustiveness guard: adding a sixth category without an icon should
    // fail here (and at the type level) rather than shipping an invisible marker.
    expect(Object.keys(AMENITY_ICONS).sort()).toEqual([...KEYS].sort());
    for (const key of KEYS) {
      expect(AMENITY_ICONS[key].shapes.length).toBeGreaterThan(0);
    }
  });

  it("draws every icon on the same 24x24 grid with the same stroke weight", () => {
    for (const key of KEYS) {
      expect(AMENITY_ICONS[key].viewBox).toBe(ICON_VIEWBOX);
      expect(AMENITY_ICONS[key].strokeWidth).toBe(1.8);
    }
  });

  it("keeps every path command inside the design grid", () => {
    // A shape drifting outside 0..24 would be clipped in the sprite, silently
    // truncating the icon.
    for (const key of KEYS) {
      for (const shape of AMENITY_ICONS[key].shapes) {
        if (shape.kind === "rect") {
          expect(shape.x + shape.width).toBeLessThanOrEqual(24);
          expect(shape.y + shape.height).toBeLessThanOrEqual(24);
          continue;
        }
        const numbers = shape.d.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
        expect(numbers.length).toBeGreaterThan(0);
        for (const value of numbers) expect(Math.abs(value)).toBeLessThanOrEqual(24);
      }
    }
  });

  it("gives each category a distinct shape set, so no two icons are confusable", () => {
    const signatures = KEYS.map((key) => JSON.stringify(AMENITY_ICONS[key].shapes));
    expect(new Set(signatures).size).toBe(KEYS.length);
  });
});

describe("amenityIconImageId / expression", () => {
  it("namespaces image ids per category", () => {
    expect(amenityIconImageId("groceries")).toBe("amenity-icon-groceries");
    expect(new Set(KEYS.map(amenityIconImageId)).size).toBe(KEYS.length);
  });

  it("builds a match expression over category with a fallback image", () => {
    const expr = amenityIconImageExpression();
    expect(expr[0]).toBe("match");
    expect(expr[1]).toEqual(["get", "category"]);
    for (const key of KEYS) {
      expect(expr).toContain(key);
      expect(expr).toContain(amenityIconImageId(key));
    }
    // Odd tail => a fallback is present, so an unknown category still paints.
    expect((expr.length - 2) % 2).toBe(1);
    expect(expr[expr.length - 1]).toBe(amenityIconImageId("transit"));
  });
});

describe("amenityIconSvg", () => {
  it("emits a standalone, well-formed SVG at the requested size and colour", () => {
    const svg = amenityIconSvg("groceries", { sizePx: 28, color: "#08100d" });
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('width="28" height="28"');
    expect(svg).toContain(`viewBox="${ICON_VIEWBOX}"`);
    expect(svg).toContain('stroke="#08100d"');
    expect(svg).toContain('fill="none"');
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
  });

  it("serialises rects and paths, including per-shape line caps and joins", () => {
    const transit = amenityIconSvg("transit", { sizePx: 24, color: "#000" });
    expect(transit).toContain('<rect x="5" y="3" width="14" height="14" rx="3"/>');
    expect(transit).toContain('stroke-linecap="round"');

    const pharmacy = amenityIconSvg("pharmacies", { sizePx: 24, color: "#000" });
    expect(pharmacy).toContain('stroke-linejoin="round"');
    // Pharmacy's cross has no cap in the source shape — don't invent one.
    expect(pharmacy).not.toContain("stroke-linecap");
  });

  it("emits one element per shape for multi-shape icons", () => {
    const schools = amenityIconSvg("schools", { sizePx: 24, color: "#000" });
    expect(schools.match(/<path /g) ?? []).toHaveLength(2);
  });

  it("produces a renderable document for every category with no undefined leaking in", () => {
    for (const key of KEYS as AmenityCategoryKey[]) {
      const svg = amenityIconSvg(key, { sizePx: 32, color: "#08100d" });
      expect(svg).not.toMatch(/undefined|NaN|null/);
      expect(svg).toMatch(/<(path|rect) /);
    }
  });
});
