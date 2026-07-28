import type maplibregl from "maplibre-gl";

import { AMENITY_CATEGORIES, type AmenityCategoryKey } from "@/features/amenities/amenities";
import { amenityIconImageId, amenityIconSvg } from "@/features/amenities/amenity-icons";

/**
 * Registers the per-category amenity icons as MapLibre sprite images (task 061).
 *
 * The icon symbol layer references these by id, so they must exist BEFORE it
 * first paints or pins render blank — and they must be re-registered whenever the
 * style reloads, because a style change drops every runtime-added image.
 *
 * Drawn via an SVG data URI into an `Image`, then handed to `addImage` at
 * `pixelRatio: 2` so the 24×24 design grid stays crisp on retina without the
 * layer needing a different `icon-size`.
 */

/** Rendered sprite size in device pixels (2× the ~15px on-screen icon). */
export const AMENITY_ICON_SIZE_PX = 30;
export const AMENITY_ICON_PIXEL_RATIO = 2;

/** Icon ink colour. The icons sit on saturated Okabe-Ito category fills, so a
 * near-black stroke is what keeps them legible on all five hues — the same ink
 * the retired letter glyphs used. */
export const AMENITY_ICON_COLOR = "#08100d";

/**
 * Value of the `data-amenity-encoding` stamp.
 *
 * Was `"color+glyph"` while category was encoded as a single ASCII letter. Task
 * 061 replaced those letters with real per-category icons, so the stamp changes
 * with them — a deliberate contract change (e2e pins this value), not a cosmetic
 * edit. It is only set once every icon image is actually registered, so it
 * asserts the encoding is really available rather than merely intended.
 */
export const AMENITY_ENCODING = "color+icon";

function loadSvgImage(svg: string, size: number): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image(size, size);
    img.decoding = "sync";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("amenity icon failed to decode"));
    // A data URI (not a blob URL) keeps this synchronous-ish and leak-free: there
    // is no object URL to revoke, which matters because this runs on every style
    // load for the lifetime of the map.
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
}

/**
 * Register (or re-register) every category icon on the map.
 *
 * Idempotent: an already-present image is left alone, so calling this again after
 * a style reload is safe and cheap. Resolves once every image is available, so
 * callers can add the icon layer immediately afterwards without a blank frame.
 */
export async function registerAmenityIcons(map: maplibregl.Map): Promise<void> {
  await Promise.all(
    AMENITY_CATEGORIES.map(async ({ key }) => {
      const id = amenityIconImageId(key as AmenityCategoryKey);
      if (map.hasImage(id)) return;
      const svg = amenityIconSvg(key as AmenityCategoryKey, {
        sizePx: AMENITY_ICON_SIZE_PX,
        color: AMENITY_ICON_COLOR,
      });
      try {
        const img = await loadSvgImage(svg, AMENITY_ICON_SIZE_PX);
        // Re-check: a concurrent call or a style reload may have raced us, and
        // addImage throws on a duplicate id.
        if (!map.hasImage(id)) map.addImage(id, img, { pixelRatio: AMENITY_ICON_PIXEL_RATIO });
      } catch {
        // A single undecodable icon must not abort the others or break the map;
        // the pin still renders as its coloured circle (colour remains a valid
        // category encoding, backed by the always-visible legend).
      }
    }),
  );
}

/** True when every category icon is registered — used by the load path's
 * `data-amenity-encoding` stamp and by e2e to prove icons really landed. */
export function hasAllAmenityIcons(map: Pick<maplibregl.Map, "hasImage">): boolean {
  return AMENITY_CATEGORIES.every(({ key }) => map.hasImage(amenityIconImageId(key as AmenityCategoryKey)));
}
