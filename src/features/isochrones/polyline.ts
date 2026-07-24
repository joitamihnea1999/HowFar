/**
 * Google "encoded polyline" decoder (task 054), used for MOTIS `/plan`
 * `legGeometry.points`. Transitous encodes at **precision 7** (1e7 scale) — NOT
 * the usual 1e5 the format is famous for — so the caller MUST pass the leg's own
 * `legGeometry.precision`. Verified against a live `/plan` capture: every leg's
 * decoded endpoints reproduce that leg's `from`/`to` lat/lon (see the
 * self-consistent fixture test).
 *
 * Pure + total: the encoded string is provider data reached from a client-named
 * point, so this never throws and is bounded during decoding (a crafted or
 * corrupt string can neither hang nor balloon memory):
 *   - stops after MAX_ENCODED_CHARS input characters;
 *   - stops after MAX_POLYLINE_POINTS decoded points;
 *   - stops (returning what was safely decoded) at the first coordinate that is
 *     non-finite or outside valid lat/lng range — a decode desync can't emit a
 *     point in the sea and have it drawn.
 */

/** Hard caps so a corrupt/hostile encoded string is bounded while decoding, not
 * after full materialization. Generous vs real Bucharest legs (~30–70 points /
 * ~260 chars observed); the point cap is the real payload bound. */
export const MAX_POLYLINE_POINTS = 4000;
export const MAX_ENCODED_CHARS = 64_000;

function inRange(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

/**
 * Decode an encoded polyline to `[lng, lat]` pairs (GeoJSON coordinate order) at
 * the given `precision` (decimal digits; MOTIS uses 7). Returns `[]` for a
 * non-string / empty input, and returns the safely-decoded prefix if the string
 * is over budget or desyncs into an invalid coordinate.
 */
export function decodePolyline(encoded: unknown, precision = 5): [number, number][] {
  if (typeof encoded !== "string" || encoded.length === 0) return [];
  const factor = Math.pow(10, precision);
  const limit = Math.min(encoded.length, MAX_ENCODED_CHARS);
  const coords: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < limit && coords.length < MAX_POLYLINE_POINTS) {
    let shift = 0;
    let result = 0;
    let byte: number;
    // Latitude delta (varint, 5-bit groups; high bit = continue).
    do {
      if (index >= limit) return coords; // truncated group — stop cleanly
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && shift < 32);
    // A continuation bit still set at the 32-bit ceiling is a malformed/overlong
    // varint (a corrupt or hostile string) — stop rather than accept a garbage
    // value that would decode to a bogus coordinate (review).
    if (byte >= 0x20) return coords;
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    shift = 0;
    result = 0;
    // Longitude delta.
    do {
      if (index >= limit) return coords;
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && shift < 32);
    if (byte >= 0x20) return coords;
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    const latDeg = lat / factor;
    const lngDeg = lng / factor;
    // A desync (or corrupt input) can push the accumulator out of range; stop
    // rather than emit a point that would draw in the ocean.
    if (!inRange(latDeg, lngDeg)) return coords;
    coords.push([lngDeg, latDeg]);
  }
  return coords;
}
