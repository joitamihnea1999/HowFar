import { getCachedSafe, setCachedSafe } from "@/lib/api-cache";
import { BUCHAREST_BBOX, inBucharest } from "@/lib/bounds";
import { providerFetch, ProviderError, sha256Hex, USER_AGENT } from "@/lib/providers/http";

/**
 * Photon (komoot, keyless, OSM-based) type-ahead geocoding — the autocomplete
 * source. Nominatim's ToS forbids per-keystroke autocomplete; Photon is built
 * for it. `bbox` hard-constrains results to Bucharest/Ilfov upstream (lat/lon
 * are only a ranking bias); we still defensively re-filter with `inBucharest`.
 * Server-side + best-effort cached. Be a good citizen: identifying UA + the
 * client debounces + a min query length.
 */

const BASE = "https://photon.komoot.io/api";
const HOST = "photon.komoot.io";
const MIN_INTERVAL_MS = 300;
const TIMEOUT_MS = 6_000;
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Photon bbox is minLon,minLat,maxLon,maxLat.
const BBOX = `${BUCHAREST_BBOX.minLng},${BUCHAREST_BBOX.minLat},${BUCHAREST_BBOX.maxLng},${BUCHAREST_BBOX.maxLat}`;

export interface Suggestion {
  label: string;
  lat: number;
  lng: number;
}

interface PhotonProps {
  name?: string;
  street?: string;
  housenumber?: string;
  district?: string;
  city?: string;
  state?: string;
}
interface PhotonFeature {
  geometry?: { type?: string; coordinates?: unknown };
  properties?: PhotonProps;
}

function composeLabel(p: PhotonProps | undefined): string {
  if (!p) return "";
  const street = p.street && p.housenumber ? `${p.street} ${p.housenumber}` : p.street;
  return [p.name, street, p.district, p.city, p.state]
    .map((x) => (x ?? "").trim())
    .filter(Boolean)
    .join(", ");
}

function normalize(features: PhotonFeature[]): Suggestion[] {
  const out: Suggestion[] = [];
  const seen = new Set<string>();
  for (const f of features) {
    const g = f.geometry;
    if (!g || g.type !== "Point" || !Array.isArray(g.coordinates) || g.coordinates.length < 2) continue;
    const coords = g.coordinates as unknown[];
    const lng = Number(coords[0]);
    const lat = Number(coords[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (!inBucharest(lat, lng)) continue; // defensive; bbox already constrains upstream
    const label = composeLabel(f.properties);
    if (!label || seen.has(label)) continue; // drop blank + duplicate rows
    seen.add(label);
    out.push({ label, lat, lng });
  }
  return out;
}

/** Type-ahead address suggestions for a partial query, Bucharest-constrained. */
export async function suggest(query: string): Promise<Suggestion[]> {
  const q = query.trim();
  const key = `suggest:${sha256Hex(q.toLowerCase())}`;
  const hit = await getCachedSafe<Suggestion[]>(key);
  if (hit) return hit;

  let body: { features?: PhotonFeature[] };
  try {
    const url = `${BASE}?q=${encodeURIComponent(q)}&bbox=${BBOX}&lat=44.43&lon=26.10&limit=8&lang=en`;
    const res = await providerFetch(url, {
      rateHost: HOST,
      minIntervalMs: MIN_INTERVAL_MS,
      timeoutMs: TIMEOUT_MS,
      init: { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } },
    });
    if (!res.ok) throw new ProviderError(`photon responded ${res.status}`);
    body = (await res.json()) as { features?: PhotonFeature[] };
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    throw new ProviderError(`photon request failed: ${(err as Error).message}`);
  }

  // A 200 with a null/garbled body must not throw outside the try (→ 500); a
  // missing features array just yields no suggestions.
  const suggestions = normalize(body?.features ?? []);
  await setCachedSafe(key, suggestions, new Date(Date.now() + TTL_MS));
  return suggestions;
}
