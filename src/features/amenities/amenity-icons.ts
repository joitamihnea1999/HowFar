/**
 * Per-category icon shapes — the single source of truth for BOTH the React
 * `AmenityPanel` tiles/rows and the MapLibre sprite images (task 061).
 *
 * Before this module, the map encoded category as a single ASCII letter
 * (`G`/`+`/`P`/`S`/`T`) while the review drew proper glyphs, so the two halves of
 * the product spoke different visual languages and a marker could only be
 * decoded by consulting the legend. Both now render the same shapes from the
 * same data.
 *
 * Shapes are described declaratively (not as raw SVG markup) for two reasons:
 * React can map them to real `<path>`/`<rect>` elements with no
 * `dangerouslySetInnerHTML`, and the sprite builder can serialise them to an SVG
 * string for `map.addImage`. The `Record` is exhaustive over
 * `AmenityCategoryKey`, so adding a sixth category is a type error here rather
 * than a blank pin discovered on the map.
 */

import type { AmenityCategoryKey } from "@/features/amenities/amenities";

export type IconShape =
  | { kind: "path"; d: string; cap?: "round"; join?: "round" }
  | { kind: "rect"; x: number; y: number; width: number; height: number; rx: number };

export interface AmenityIcon {
  /** All icons share a 24×24 design grid. */
  viewBox: string;
  strokeWidth: number;
  shapes: readonly IconShape[];
}

/** The 24×24 grid every icon is drawn on. */
export const ICON_VIEWBOX = "0 0 24 24";
const STROKE_WIDTH = 1.8;

export const AMENITY_ICONS: Record<AmenityCategoryKey, AmenityIcon> = {
  groceries: {
    viewBox: ICON_VIEWBOX,
    strokeWidth: STROKE_WIDTH,
    shapes: [{ kind: "path", d: "M4 5h2l1.6 9h9.8l1.5-6H7M10 18.5h.1M16.5 18.5h.1", cap: "round", join: "round" }],
  },
  pharmacies: {
    viewBox: ICON_VIEWBOX,
    strokeWidth: STROKE_WIDTH,
    shapes: [{ kind: "path", d: "M9 4h6v5h5v6h-5v5H9v-5H4V9h5V4Z", join: "round" }],
  },
  parks: {
    viewBox: ICON_VIEWBOX,
    strokeWidth: STROKE_WIDTH,
    shapes: [
      {
        kind: "path",
        d: "M12 21v-7M8.5 17.5 12 14l3.5 3.5M12 3c-4 2.2-6 5.1-6 8a6 6 0 0 0 12 0c0-2.9-2-5.8-6-8Z",
        cap: "round",
        join: "round",
      },
    ],
  },
  schools: {
    viewBox: ICON_VIEWBOX,
    strokeWidth: STROKE_WIDTH,
    shapes: [
      { kind: "path", d: "m3 9 9-5 9 5-9 5-9-5Z", join: "round" },
      { kind: "path", d: "M7 12v4.5c3 2 7 2 10 0V12M21 9v6", cap: "round" },
    ],
  },
  transit: {
    viewBox: ICON_VIEWBOX,
    strokeWidth: STROKE_WIDTH,
    shapes: [
      { kind: "rect", x: 5, y: 3, width: 14, height: 14, rx: 3 },
      { kind: "path", d: "M8 17l-1.5 3M16 17l1.5 3M8 8h8M9 13h.1M15 13h.1", cap: "round" },
    ],
  },
};

/** MapLibre image id for a category's sprite (used by the icon symbol layer). */
export function amenityIconImageId(category: AmenityCategoryKey): string {
  return `amenity-icon-${category}`;
}

/** The `icon-image` match expression mapping a feature's category to its sprite. */
export function amenityIconImageExpression(): unknown[] {
  const match: unknown[] = ["match", ["get", "category"]];
  for (const key of Object.keys(AMENITY_ICONS) as AmenityCategoryKey[]) {
    match.push(key, amenityIconImageId(key));
  }
  // Fallback keeps an unknown category visible as a generic transit-style mark
  // rather than silently dropping the symbol.
  match.push(amenityIconImageId("transit"));
  return match;
}

function shapeToSvg(shape: IconShape): string {
  if (shape.kind === "rect") {
    return `<rect x="${shape.x}" y="${shape.y}" width="${shape.width}" height="${shape.height}" rx="${shape.rx}"/>`;
  }
  const cap = shape.cap ? ` stroke-linecap="${shape.cap}"` : "";
  const join = shape.join ? ` stroke-linejoin="${shape.join}"` : "";
  return `<path d="${shape.d}"${cap}${join}/>`;
}

/**
 * Serialise one icon to a standalone SVG document at `sizePx`, stroked in
 * `color`.
 *
 * The map draws these on top of a saturated category colour, so the stroke is
 * the dark ink colour rather than `currentColor` — the same near-black the old
 * letter glyphs used, which is what keeps the icon legible against every one of
 * the five Okabe-Ito hues.
 */
export function amenityIconSvg(
  category: AmenityCategoryKey,
  { sizePx, color }: { sizePx: number; color: string },
): string {
  const icon = AMENITY_ICONS[category];
  const body = icon.shapes.map(shapeToSvg).join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${sizePx}" height="${sizePx}" viewBox="${icon.viewBox}" ` +
    `fill="none" stroke="${color}" stroke-width="${icon.strokeWidth}">${body}</svg>`);
}
