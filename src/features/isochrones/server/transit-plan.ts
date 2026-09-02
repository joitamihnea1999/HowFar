import { getCachedSafe, setCachedSafe } from "@/lib/api-cache";
import { PACE_MODEL } from "@/features/isochrones/pace";
import { decodePolyline } from "@/features/isochrones/polyline";
import { hasTransitLeg } from "@/features/isochrones/transit-classify";
import { providerConfig, taggedCacheKey } from "@/lib/env";
import { isRetriableFetchError, providerFetch, ProviderError, roundCoord, USER_AGENT } from "@/lib/provider-http";

/**
 * Transitous MOTIS journey planning (server-side, cached) for the right-click
 * "how do I get there?" popup (task 052 D). Unlike the reachability isochrone
 * (one-to-all → polygons), this asks the SAME free/keyless engine for the actual
 * best trip from the selected origin to a clicked point, so the popup can give
 * specific, actionable directions — walk to a named stop, board a named line
 * (e.g. "243", "M2") in a stated direction, transfer, then walk to the
 * destination — rather than a nearest-stop approximation. ToS: identifying
 * User-Agent + attribution to transitous.org/sources (rendered client-side).
 */

// Transitous host is config-driven (task 007) — default = today's public MOTIS,
// shared with one-to-all (transit.ts). The plan path is version-specific and
// stays in code; only the base moves.
const PLAN_PATH = "/api/v1/plan";
// Interval is config-driven (task 009, `intervals.transit`, default 1500 ms);
// shares the `provider:"transit"` bucket with one-to-all (transit.ts).
/** END-TO-END budget for resolving one trip plan: rate-limiter queue wait +
 * first attempt + the bounded retry, all under ONE absolute deadline (an
 * AbortController armed at entry — a fixed per-attempt timeout would start
 * only after the shared-host queue, so a `/plan` parked behind a slow
 * one-to-all could finish and get CACHED after the client's deadline
 * (`REACH_TIMEOUT_MS`) had already shown an error, and the very next click
 * would "heal" — the flaky-product read this task exists to kill. Budget <
 * client deadline is asserted in transit-plan.test.ts; the overrun path
 * throws a ProviderError and caches nothing. Task 018 raised it 10s→12s: the
 * owner saw "aborted at exactly 10.0s … the remote was just slow; identical
 * retries succeed", i.e. the remote wanted ~10s and hit the OLD 10s ceiling — a
 * MODESTLY longer single attempt (the owner's own suggestion) lets that remote
 * SUCCEED on the first try, without a doomed short-timeout retry. A retry still
 * fires for a FAST failure (network drop) with budget to spare; a genuine
 * timeout has no budget left, an honest failure the client's next click reheals. */
export const PLAN_BUDGET_MS = 12_000;
/** Don't bother retrying unless at least this much of the budget remains — a
 * retry needs the configured transit spacing (default 1.5 s — the interval is
 * config-driven since task 009) plus a realistic response window. Tuned for the
 * default; a self-host that sets a very different TRANSIT_MIN_INTERVAL_MS may
 * want this derived from the interval (parked follow-up). */
const RETRY_MIN_REMAINING_MS = 3_000;
/** Short backoff before the single retry (transient network drop OR an
 * effectively-empty response), bounded by the absolute budget. */
const RETRY_BACKOFF_MS = 250;
// Schedules are stable within a day and the departure is in the cache key, so a
// few hours of reuse is safe and keeps repeat right-clicks instant.
const TTL_MS = 6 * 60 * 60 * 1000;
/** Short TTL for answers WITHOUT a useful transit leg (unreachable / walk-only /
 * walk-dominated). These render as "No public-transport route", so caching one
 * for 6h pins a possibly-transient miss (provider hiccup, boundary case) to its
 * ~1.1m coordinate cell. A genuine no-service answer is cheap to re-derive. */
const NO_TRANSIT_TTL_MS = 5 * 60 * 1000;
/**
 * Maximum LAST street leg (seconds) for `/plan`, mirroring the painted rings:
 * the transit isochrone's egress is OUR radial walk model, which may spend the
 * whole remaining band walking from the alight stop (up to 45 min), while MOTIS
 * defaults `maxPostTransitTime` to 900s — so a point could be painted reachable
 * yet get "no route" from `/plan`, flipping within meters at the 15-min-walk
 * frontier (the owner-reported right-click flake). 2700s = the 45-min band, the
 * egress model's own extreme. `maxPreTransitTime` deliberately stays at the
 * 900s default: the rings' one-to-all sends no override either, so raising it
 * would surface trips the map never painted (review).
 */
export const PLAN_MAX_POST_TRANSIT_S = 2700;
/** Pedestrian contract for `/plan`, identical to the one-to-all call that
 * paints the rings (transit.ts): Normal pace (transit pace is always Normal —
 * task 052, `effectivePace`) + OSM-routed transfers. Divergent walking
 * semantics between the two calls is another painted-vs-planned mismatch
 * source. Sourced from PACE_MODEL so the two calls can never drift apart. */
export const PLAN_PEDESTRIAN_SPEED_MS = PACE_MODEL.normal.pedestrianSpeedMs;
/** Legs-per-itinerary cap (payload bound). Bucharest trips run ~3–9 legs; a
 * value well above that drops only degenerate/hostile responses (task 054). */
const MAX_REACH_LEGS = 24;

/** A leg endpoint's coordinates ([lng, lat] carried as named fields). Optional:
 * a malformed leg without finite coords still lists its step, it just can't be
 * drawn (task 054). */
export interface ReachPoint {
  lat: number;
  lng: number;
}

export interface ReachLeg {
  /** MOTIS mode: WALK | BUS | TRAM | SUBWAY | RAIL | COACH | … */
  mode: string;
  /** The line's public short name (e.g. "243", "M2") — transit legs only. */
  line?: string;
  /** The line's destination sign (direction) — transit legs only. */
  headsign?: string;
  /** Board/alight place names ("START"/"END" for the trip endpoints). */
  fromName: string;
  toName: string;
  minutes: number;
  /** Board/alight coordinates, surfaced so the client can highlight the stops
   * the rider actually uses (task 054). Absent when the leg lacks finite coords. */
  from?: ReachPoint;
  to?: ReachPoint;
  /** The leg's drawn track as [lng, lat] points, decoded from MOTIS
   * `legGeometry` (Google-encoded polyline, precision 7). Empty/absent when the
   * leg carried no geometry or it decoded to nothing — the client then falls back
   * to a straight from→to line so a transfer/alight is never silently omitted. */
  path?: [number, number][];
}

export type ReachPlan =
  | { reachable: true; totalMinutes: number; transfers: number; legs: ReachLeg[] }
  | { reachable: false };

interface MotisPlace {
  name?: unknown;
  lat?: unknown;
  lon?: unknown;
}
interface MotisLegGeometry {
  points?: unknown;
  precision?: unknown;
}
interface MotisLeg {
  mode?: unknown;
  duration?: unknown;
  from?: MotisPlace | null;
  to?: MotisPlace | null;
  routeShortName?: unknown;
  headsign?: unknown;
  legGeometry?: MotisLegGeometry | null;
}
interface MotisItinerary {
  duration?: unknown;
  transfers?: unknown;
  legs?: MotisLeg[];
}
interface MotisPlanBody {
  itineraries?: MotisItinerary[];
  /** Non-transit (walk/bike) options MOTIS returns separately — used as a
   * fallback so a very-close destination gets a walking answer instead of a
   * false "no public-transport route" (impl-panel T4). */
  direct?: MotisItinerary[];
}

function placeName(p: MotisPlace | null | undefined): string {
  return typeof p?.name === "string" ? p.name : "";
}
/** A leg endpoint's coords, or undefined when either is missing / non-numeric /
 * out of range — a leg without drawable coords still lists as a step. Requires
 * an ACTUAL number (not a coercible null/""): `Number(null)` is 0, which would
 * otherwise plant a false (0,0) stop off West Africa (review). */
function placePoint(p: MotisPlace | null | undefined): ReachPoint | undefined {
  const lat = p?.lat;
  const lng = p?.lon;
  if (typeof lat !== "number" || typeof lng !== "number") return undefined;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return undefined;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return undefined;
  return { lat, lng };
}
/** Transitous encodes `legGeometry` at precision 7. Default to 7 (NOT the format's
 * usual 5) when the field is missing, so a dropped precision degrades to correct
 * decoding rather than silently pushing every path 100× out of range → empty →
 * straight-line-only draw (review). */
const DEFAULT_LEG_PRECISION = 7;
/** Decode a MOTIS leg's `legGeometry` to a bounded [lng,lat] track. */
function legPath(g: MotisLegGeometry | null | undefined): [number, number][] {
  if (!g || typeof g !== "object") return [];
  const precision = Number(g.precision);
  return decodePolyline(g.points, Number.isFinite(precision) && precision > 0 ? precision : DEFAULT_LEG_PRECISION);
}
function minutesOf(seconds: unknown): number {
  const s = Number(seconds);
  return Number.isFinite(s) && s > 0 ? Math.round(s / 60) : 0;
}
/** Raw trip duration in seconds (0 for missing/non-positive) — used for RANKING,
 * so a sub-minute difference is not lost to rounding (task 057). `minutesOf` is
 * for DISPLAY only. */
function durationSeconds(seconds: unknown): number {
  const s = Number(seconds);
  return Number.isFinite(s) && s > 0 ? s : 0;
}
/** A finite, non-negative integer transfer count from untrusted MOTIS input —
 * one source for both parsing and scoring, so the comparator can't see NaN or a
 * negative reward (task 057). */
function normTransfers(v: unknown): number {
  const t = Number(v);
  return Number.isFinite(t) && t > 0 ? Math.trunc(t) : 0;
}

/**
 * Per-transfer penalty (seconds) applied when RANKING itineraries: an extra
 * transfer must save MORE than this to be recommended (task 057). Real riders —
 * and the owner's feedback — prefer a simpler, more-direct trip over shaving a
 * few minutes with an extra vehicle. Calibrated against a real MOTIS capture
 * where a direct Tram-1 trip (1800s) and a Tram+Bus trip (1500s) differ by
 * exactly 300s: at 360s the direct trip wins STRICTLY (not via a fragile tie),
 * while a transfer that genuinely saves >6 min still wins.
 */
export const TRANSFER_PENALTY_S = 360;
function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/**
 * Trim one MOTIS itinerary to the fields the popup renders. Drops negligible
 * (<1 min) WALK legs — the engine emits 0-minute START/END walk stubs when the
 * origin/destination sits on a stop. An itinerary that trims to no legs is not a
 * usable answer. Pure + exported for tests.
 */
export function parseItinerary(it: MotisItinerary): ReachPlan {
  const rawLegs = Array.isArray(it?.legs) ? it.legs : [];
  const legs: ReachLeg[] = [];
  for (const l of rawLegs) {
    // Bound legs-per-itinerary: with each leg's `path` now up to
    // MAX_POLYLINE_POINTS, a degenerate/hostile MOTIS response could otherwise
    // build a multi-MB ReachPlan that gets cached (6h) and shipped to the client.
    // A real Bucharest trip is well under this (review).
    if (legs.length >= MAX_REACH_LEGS) break;
    if (!l || typeof l !== "object") continue; // tolerate null/garbled leg entries (T2)
    const mode = str(l.mode) ?? "UNKNOWN";
    const minutes = minutesOf(l.duration);
    const isWalk = mode === "WALK";
    if (isWalk && minutes < 1) continue; // drop 0-min START/END walk stubs
    const leg: ReachLeg = {
      mode,
      fromName: placeName(l.from),
      toName: placeName(l.to),
      minutes,
      // Coords + decoded track ride along so the client can DRAW the journey
      // (task 054); from/to are kept even when the path decodes to nothing.
      from: placePoint(l.from),
      to: placePoint(l.to),
      path: legPath(l.legGeometry),
    };
    if (!isWalk) {
      const line = str(l.routeShortName);
      if (line) leg.line = line;
      const headsign = str(l.headsign);
      if (headsign) leg.headsign = headsign;
    }
    legs.push(leg);
  }
  if (legs.length === 0) return { reachable: false };
  return {
    reachable: true,
    totalMinutes: minutesOf(it.duration),
    transfers: normTransfers(it.transfers),
    legs,
  };
}

/**
 * Pick the best itinerary and trim it. MOTIS does NOT return itineraries sorted
 * usefully, so we rank ourselves. Transit options (`itineraries`) win; if there
 * are none, fall back to `direct` (walk/bike) so a very-close destination still
 * gets an answer (T4). Itineraries without a finite positive duration are dropped
 * (T2).
 *
 * Ranking (task 057) is a TRANSFER-PENALISED total order on RAW seconds — an
 * extra transfer must save more than `TRANSFER_PENALTY_S` to be chosen, so we
 * recommend the direct/simpler trip the owner expects rather than an uglier
 * transfer that shaves a couple of minutes. Locked total order (no rounding):
 *   1. `durationSec + TRANSFER_PENALTY_S × transfers` ascending (the penalised cost)
 *   2. `transfers` ascending (at equal cost, fewer transfers wins)
 *   3. `durationSec` ascending (final deterministic tie-break)
 *
 * `maxSeconds` (the clicked reach band) pre-filters to trips within the painted
 * "~N-min reach" WHEN ANY QUALIFY, so the penalty can never surface a trip that
 * exceeds the reach the user is looking at. Pure + exported.
 */
export function bestPlan(body: MotisPlanBody, opts?: { maxSeconds?: number }): ReachPlan {
  const usable = (list: MotisItinerary[] | undefined): MotisItinerary[] =>
    (Array.isArray(list) ? list : []).filter((it) => it && durationSeconds(it.duration) > 0);
  const transit = usable(body.itineraries);
  const candidates = transit.length > 0 ? transit : usable(body.direct);
  if (candidates.length === 0) return { reachable: false };

  const cost = (it: MotisItinerary): number =>
    durationSeconds(it.duration) + TRANSFER_PENALTY_S * normTransfers(it.transfers);
  const ranked = [...candidates].sort((a, b) => {
    const ca = cost(a);
    const cb = cost(b);
    if (ca !== cb) return ca - cb;
    const ta = normTransfers(a.transfers);
    const tb = normTransfers(b.transfers);
    if (ta !== tb) return ta - tb;
    return durationSeconds(a.duration) - durationSeconds(b.duration);
  });
  // Within-band preference is a PARTITION of the cost order, not a filter: an
  // over-band candidate stays eligible behind the in-band ones, so a malformed
  // in-band winner can never turn the whole response into a false "not
  // reachable" while a valid over-band trip exists.
  const maxSeconds = opts?.maxSeconds;
  const inBand = (it: MotisItinerary): boolean =>
    typeof maxSeconds === "number" && maxSeconds > 0 ? durationSeconds(it.duration) <= maxSeconds : true;
  const ordered = [...ranked.filter(inBand), ...ranked.filter((it) => !inBand(it))];
  // Take the best candidate that PARSES to a usable answer — a malformed winner
  // (e.g. legs that all trim away) must not bury a valid runner-up (review).
  for (const candidate of ordered) {
    const plan = parseItinerary(candidate);
    if (plan.reachable) return plan;
  }
  return { reachable: false };
}

// In-flight requests keyed by cache key: concurrent cold right-clicks on the
// same trip share ONE /plan request (the ors.ts / transit.ts single-flight).
const inFlight = new Map<string, Promise<ReachPlan>>();

/** Plan the best public-transport trip from `from` to `to` departing at
 * `departureIso` (the selection's resolved departure, so it matches the painted
 * rings' time). Cached + single-flighted. Throws ProviderError on a provider
 * failure (→ 502); a genuine "no route" is a cacheable `{reachable:false}`. */
export async function planTrip(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
  departureIso: string,
  maxMinutes?: number,
): Promise<ReachPlan> {
  // v4 (task 063): the request contract changed (maxPostTransitTime +
  // pedestrianSpeed + useRoutedTransfers) — a cached v3 plan could keep serving
  // a "no route" answer the new limits would revive. v5 (task 064): the
  // pedestrian speed sent to /plan changed 1.333 -> 1.389 m/s, so the walking
  // legs (and therefore the chosen itinerary) can differ. maxMinutes is in the
  // key because it changes the selected itinerary.
  const band = typeof maxMinutes === "number" && maxMinutes > 0 ? Math.round(maxMinutes) : 0;
  const key = taggedCacheKey(
    `reach:plan:v5:${roundCoord(from.lat)},${roundCoord(from.lng)}:${roundCoord(to.lat)},${roundCoord(to.lng)}:${departureIso}:${band}`,
  );
  const hit = await getCachedSafe<ReachPlan>(key);
  if (hit) return hit;
  const existing = inFlight.get(key);
  if (existing) return existing;
  const promise = fetchAndParse(from, to, departureIso, key, band > 0 ? band * 60 : undefined);
  inFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(key);
  }
}

async function fetchPlanBody(
  url: string,
  host: string,
  minIntervalMs: number,
  budgetSignal: AbortSignal,
): Promise<MotisPlanBody> {
  let body: MotisPlanBody;
  try {
    const res = await providerFetch(url, {
      provider: "transit",
      rateHost: host,
      minIntervalMs,
      // The attempt runs to the absolute budget; the budget signal is what
      // bounds the whole call (single modestly-long attempt, task 018).
      timeoutMs: PLAN_BUDGET_MS,
      signal: budgetSignal,
      init: { headers: { "User-Agent": USER_AGENT } },
    });
    if (!res.ok) throw new ProviderError(`transitous plan responded ${res.status}`);
    body = (await res.json()) as MotisPlanBody;
  } catch (err) {
    if (err instanceof ProviderError) throw err; // upstream STATUS — deterministic (retriable stays false)
    // A network drop / abort is transient — tag it so the unified retry loop in
    // fetchAndParse can retry it (once, within budget) after wrapping.
    throw new ProviderError(`transitous plan request failed: ${(err as Error).message}`, {
      retriable: isRetriableFetchError(err),
    });
  }
  if (!Array.isArray(body?.itineraries)) {
    throw new ProviderError("transitous plan returned a malformed response (no itineraries array)");
  }
  return body;
}

async function fetchAndParse(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
  departureIso: string,
  key: string,
  maxSeconds?: number,
): Promise<ReachPlan> {
  const { transitBase, intervals } = providerConfig();
  const host = new URL(transitBase).host;
  const url =
    `${transitBase}${PLAN_PATH}?fromPlace=${roundCoord(from.lat)},${roundCoord(from.lng)}` +
    `&toPlace=${roundCoord(to.lat)},${roundCoord(to.lng)}` +
    `&time=${encodeURIComponent(departureIso)}&arriveBy=false` +
    // Match the painted rings' walking contract (see the constants above): the
    // rings' egress model allows walking the whole remaining band from the
    // alight stop, so the planner must too — with MOTIS's 900s default, points
    // >15-min walk from every stop answered "no route" while painted reachable.
    `&maxPostTransitTime=${PLAN_MAX_POST_TRANSIT_S}` +
    `&pedestrianSpeed=${PLAN_PEDESTRIAN_SPEED_MS}&useRoutedTransfers=true`;

  // ONE absolute deadline for queue wait + attempt + retry (see PLAN_BUDGET_MS).
  const deadline = Date.now() + PLAN_BUDGET_MS;
  const budget = new AbortController();
  const budgetTimer = setTimeout(() => budget.abort(), PLAN_BUDGET_MS);

  // What the budget guarantees: no SUCCESS can resolve (and thus be cached)
  // after the deadline — the signal kills an in-flight fetch at PLAN_BUDGET_MS,
  // so a late answer can never be cached after the client's REACH_TIMEOUT_MS
  // deadline showed an error (the heal-loop). What it does NOT bound: the
  // shared-host queue wait itself, so the resulting ProviderError may surface
  // later than PLAN_BUDGET_MS — an
  // honest, uncached, retryable failure (review: accepted residual; making the
  // limiter signal-aware would touch every provider for no material gain).
  const isTransitAnswer = (p: ReachPlan): boolean => p.reachable && hasTransitLeg(p.legs);
  const usableDirect = (b: MotisPlanBody): boolean =>
    (Array.isArray(b.direct) ? b.direct : []).some((it) => it && durationSeconds(it.duration) > 0);
  const canRetry = () => Date.now() + RETRY_MIN_REMAINING_MS < deadline;

  // ONE unified retry loop, capped at TWO fetchPlanBody calls total (task 018 —
  // nesting a fetch-failure retry INSIDE the empty-response retry could reach
  // 3–4 upstream calls on the shared 1.5 s transit bucket, poor citizenship on a
  // community host). A single retry
  // covers BOTH transient signatures — a network drop/abort (`err.retriable`)
  // and an effectively-empty response (no transit AND no direct, the replica-
  // mid-update signature) — each retried at most once, never past the budget,
  // and a failed retry NEVER discards a determinate first answer.
  let plan: ReachPlan | null = null;
  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      let body: MotisPlanBody;
      try {
        body = await fetchPlanBody(url, host, intervals.transit, budget.signal);
      } catch (err) {
        // Keep a DETERMINATE reachable first answer (transit OR a walk-only/
        // UNKNOWN-mode itinerary) rather than discard it on a retry throw (G4).
        if (plan?.reachable) break;
        const retriable = err instanceof ProviderError && err.retriable;
        // A suspect-empty first answer we retried to confirm: retry only a
        // transient failure with budget to spare.
        if (attempt < 2 && retriable && canRetry()) {
          await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS));
          continue;
        }
        // Confirmation retry failed. If it was TRANSIENT (network/abort) we still
        // haven't confirmed the empty — surface an honest failure, cache nothing
        // (F1 Critical). But a DETERMINISTIC failure (429/503/malformed) gives no
        // new reachability info, so keep the first empty observation rather than
        // turn a correct "no route" into a 502 on a rate-limited host (H4).
        if (plan !== null && !retriable) break;
        throw err;
      }
      const candidate = bestPlan(body, { maxSeconds });
      if (isTransitAnswer(candidate)) {
        plan = candidate; // best possible answer — done
        break;
      }
      if (plan === null) plan = candidate; // remember the first determinate (not-reachable / direct)
      if (usableDirect(body)) break; // a direct (walk/bike) answer is DETERMINATE — don't retry (citizenship)
      if (attempt >= 2 || !canRetry()) break; // effectively-empty, but out of retries/budget
      await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS)); // empty → retry once
    }
  } finally {
    clearTimeout(budgetTimer);
  }
  // Unreachable — the loop sets plan on any successful fetch and throws otherwise
  // — but keeps the type honest.
  if (plan === null) throw new ProviderError("transitous plan request failed: no response");
  // TTL by answer kind: only a real public-transport answer is stable enough to
  // keep for hours; a plan with no transit leg (unreachable, or the walk/bike
  // direct fallback — both rendered as "No public-transport route") heals in
  // minutes instead of pinning a possibly-transient miss to this cell for 6h.
  const ttl = plan.reachable && hasTransitLeg(plan.legs) ? TTL_MS : NO_TRANSIT_TTL_MS;
  await setCachedSafe(key, plan, new Date(Date.now() + ttl));
  return plan;
}
