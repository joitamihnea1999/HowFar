import { getCachedSafe, setCachedSafe } from "@/lib/api-cache";
import { LAUNCH_BBOX, inLaunchArea } from "@/lib/bounds";
import { providerConfig, taggedCacheKey } from "@/lib/env";
import { providerFetch, ProviderError, sha256Hex, USER_AGENT } from "@/lib/provider-http";

/**
 * Photon (komoot, keyless, OSM-based) type-ahead geocoding — the autocomplete
 * source. Nominatim's ToS forbids per-keystroke autocomplete; Photon is built
 * for it. `bbox` hard-constrains results to Bucharest/Ilfov upstream (lat/lon
 * are only a ranking bias); we still defensively re-filter with `inLaunchArea`.
 * Server-side + best-effort cached. Be a good citizen: identifying UA + the
 * client debounces + a min query length.
 */

// Host/base are config-driven (task 007) — default = today's public Photon.
// Read inside the fetch function; the rate-limit host derives from the base.
// Interval is config-driven too (task 009, `intervals.photon`, default 300 ms).
const TIMEOUT_MS = 6_000;
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Photon bbox is minLon,minLat,maxLon,maxLat.
const BBOX = `${LAUNCH_BBOX.minLng},${LAUNCH_BBOX.minLat},${LAUNCH_BBOX.maxLng},${LAUNCH_BBOX.maxLat}`;

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
    if (!inLaunchArea(lat, lng)) continue; // defensive; bbox already constrains upstream
    const label = composeLabel(f.properties);
    if (!label || seen.has(label)) continue; // drop blank + duplicate rows
    seen.add(label);
    out.push({ label, lat, lng });
  }
  return out;
}

// Coalesce concurrent cold suggests for the same key (typing storms).
const inFlight = new Map<string, Promise<Suggestion[]>>();

/** Type-ahead address suggestions for a partial query, Bucharest-constrained. */
export async function suggest(query: string): Promise<Suggestion[]> {
  const q = query.trim();
  const key = taggedCacheKey(`suggest:${sha256Hex(q.toLowerCase())}`);
  const hit = await getCachedSafe<Suggestion[]>(key);
  if (hit) return hit;

  const existing = inFlight.get(key);
  if (existing) return existing;

  const promise = fetchAndCacheSuggestions(key, q);
  inFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(key);
  }
}

async function fetchAndCacheSuggestions(key: string, q: string): Promise<Suggestion[]> {
  let body: { features?: PhotonFeature[] };
  try {
    const { photonBase, intervals } = providerConfig();
    // `/api` is Photon's search path (kept in code so PHOTON_BASE_URL is a bare
    // host like the other providers). The lat/lon focus is a ranking bias only,
    // kept unchanged here; deriving it from the bbox centre is a later follow-up.
    const url = `${photonBase}/api?q=${encodeURIComponent(q)}&bbox=${BBOX}&lat=44.43&lon=26.10&limit=8&lang=en`;
    const res = await providerFetch(url, {
      provider: "photon",
      rateHost: new URL(photonBase).host,
      minIntervalMs: intervals.photon,
      timeoutMs: TIMEOUT_MS,
      init: { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } },
    });
    if (!res.ok) throw new ProviderError(`photon responded ${res.status}`);
    body = (await res.json()) as { features?: PhotonFeature[] };
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    throw new ProviderError(`photon request failed: ${(err as Error).message}`);
  }

  // A 200 with a null body must not throw outside the try (→ 500); a MISSING
  // features array just yields no suggestions, but a PRESENT non-array one is
  // a garbled response and must become a 502 (mirrors transit's guard).
  if (body?.features !== undefined && !Array.isArray(body.features)) {
    throw new ProviderError("photon returned a malformed response (features not an array)");
  }
  const suggestions = normalize(body?.features ?? []);
  await setCachedSafe(key, suggestions, new Date(Date.now() + TTL_MS));
  return suggestions;
}
