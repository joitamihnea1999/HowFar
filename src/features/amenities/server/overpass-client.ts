import { providerFetch, ProviderError, USER_AGENT } from "@/lib/provider-http";

/**
 * Shared Overpass transport: POST a QL query and RACE a small pool of public
 * instances (Promise.any) — the first healthy responder wins, losers are
 * aborted. Public Overpass instances are individually flaky, so racing turns
 * "all must be up in order" into "any one must be up". Used by BOTH the amenity
 * envelope query and the per-stop route-relation query (task 021), so the
 * fair-use posture (identifying UA, per-host rate limit, abort-on-win) lives in
 * one place.
 *
 * The one query-specific knob is `treatEmptyAsFailure`: a 1500m 5-category
 * amenity envelope is NEVER legitimately empty (there's always a bus stop), so
 * an empty body signals a degraded mirror and is treated as a race loss. A
 * single-stop route query, by contrast, is legitimately empty for a stop that
 * serves no mapped routes — there the caller passes `false` so `[]` resolves as
 * a valid answer instead of a 502.
 */

// Ordered by observed reliability (probed 2026-07-17): maps.mail.ru answered the
// live query every round (~2s); overpass-api.de is variable (fast, or 504 under
// load); kumi is kept as a third hedge (was fully down when probed, may recover).
// Racing means a currently-dead host costs nothing — it simply never wins.
const ENDPOINTS: { url: string; host: string }[] = [
  { url: "https://maps.mail.ru/osm/tools/overpass/api/interpreter", host: "maps.mail.ru" },
  { url: "https://overpass-api.de/api/interpreter", host: "overpass-api.de" },
  { url: "https://overpass.kumi.systems/api/interpreter", host: "overpass.kumi.systems" },
];
const MIN_INTERVAL_MS = 1100; // be a good fair-use citizen (per host)
const ENDPOINT_TIMEOUT_MS = 18_000; // per-host abort; the race isn't sequential so this is the whole budget

export interface OverpassElement {
  type?: string;
  id?: number;
  lat?: number;
  lon?: number;
  center?: { lat?: number; lon?: number };
  tags?: Record<string, string>;
  members?: { type?: string; ref?: number; role?: string }[];
}

interface OverpassBody {
  elements?: OverpassElement[];
  remark?: string;
}

/** Thrown by a host that returned a valid but EMPTY envelope when the caller
 * tolerates empties (`treatEmptyAsFailure:false`). It makes `Promise.any` skip
 * this host so a slower host with REAL data can still win the race; only if
 * every host ends up empty-or-errored (with ≥1 empty) does the race resolve to
 * `[]`. Without this, the fastest degraded mirror's `[]` would beat a healthy
 * host and cache a false "no lines" (task 021). */
class EmptyResultError extends Error {
  constructor(host: string) {
    super(`overpass ${host} returned an empty envelope (tolerated)`);
    this.name = "EmptyResultError";
  }
}

/** POST the QL to one host. Throws (raw or ProviderError) on any failure so a
 * losing host can't sink the race. A soft failure — HTTP 200 with a
 * timeout/quota `remark` or a non-array `elements` — counts as a failure too.
 * An empty `elements` array is a failure only when `treatEmptyAsFailure`.
 * `signal` cancels this request when a sibling host wins the race. */
async function fetchFromHost(
  endpoint: { url: string; host: string },
  query: string,
  raceSignal: AbortSignal,
  treatEmptyAsFailure: boolean,
): Promise<OverpassElement[]> {
  // A per-attempt deadline that stays armed THROUGH body parsing. providerFetch's
  // internal timeout only guards until response headers arrive — a host that
  // sends 200 headers then stalls the body would otherwise keep the race pending
  // forever if the siblings have already failed. Merge it with the race signal
  // (which aborts this attempt the moment a sibling wins).
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), ENDPOINT_TIMEOUT_MS);
  try {
    const res = await providerFetch(endpoint.url, {
      rateHost: endpoint.host,
      minIntervalMs: MIN_INTERVAL_MS,
      timeoutMs: ENDPOINT_TIMEOUT_MS,
      signal: AbortSignal.any([deadline.signal, raceSignal]),
      init: {
        method: "POST",
        headers: {
          "User-Agent": USER_AGENT,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: `data=${encodeURIComponent(query)}`,
      },
    });
    if (!res.ok) throw new ProviderError(`overpass ${endpoint.host} responded ${res.status}`);
    const body = (await res.json()) as OverpassBody;
    if (!Array.isArray(body.elements)) {
      throw new ProviderError(`overpass ${endpoint.host} returned no element array`);
    }
    // Overpass signals server-side timeout/quota via a 200 + `remark`, often with
    // empty/partial elements — treat that as a failure so another host can win.
    if (body.remark && /timed out|timeout|quota|error|exceeded/i.test(body.remark)) {
      throw new ProviderError(`overpass ${endpoint.host} remark: ${body.remark}`);
    }
    // A truly empty envelope is never legitimate for a guarded Bucharest-bbox
    // amenity query (5 broad categories within 1500m — there's always at least a
    // bus stop). A mirror returning [] without a remark is degraded; treat it as
    // a loss so a healthy host wins, and so we never cache an empty set. For a
    // single-stop query (treatEmptyAsFailure=false) [] is a legitimate answer,
    // but still a RACE LOSS (via EmptyResultError) so a slower host with real
    // routes wins — only an all-empty race resolves to [].
    if (body.elements.length === 0) {
      throw treatEmptyAsFailure
        ? new ProviderError(`overpass ${endpoint.host} returned an empty envelope`)
        : new EmptyResultError(endpoint.host);
    }
    return body.elements;
  } finally {
    clearTimeout(timer);
  }
}

/** Race the endpoint pool: the first host to return a valid response wins and
 * the rest are aborted; ProviderError only if EVERY host fails. */
export async function raceOverpass(
  query: string,
  opts: { treatEmptyAsFailure?: boolean } = {},
): Promise<OverpassElement[]> {
  const treatEmptyAsFailure = opts.treatEmptyAsFailure ?? true;
  const controller = new AbortController();
  const attempts = ENDPOINTS.map((ep) =>
    fetchFromHost(ep, query, controller.signal, treatEmptyAsFailure),
  );
  try {
    // First NON-EMPTY success wins (empties threw, so Promise.any skips them).
    return await Promise.any(attempts);
  } catch (err) {
    const errors = err instanceof AggregateError ? err.errors : [err];
    // Tolerated-empty race: if no host had data but at least one legitimately
    // returned [], resolve to [] ("no mapped routes") rather than a 502.
    if (!treatEmptyAsFailure && errors.some((e) => e instanceof EmptyResultError)) {
      return [];
    }
    const reasons = errors.map((e) => (e instanceof Error ? e.message : String(e))).join("; ");
    throw new ProviderError(`overpass unavailable (all endpoints failed: ${reasons})`);
  } finally {
    controller.abort(); // cancel the losers (no-op once they've settled)
  }
}
