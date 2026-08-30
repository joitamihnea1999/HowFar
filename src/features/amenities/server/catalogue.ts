import { type AmenityCountsByBand } from "@/features/amenities/amenities";
import {
  queryCatalogueSummaryInRing,
  type CatalogueAmenity,
} from "@/features/amenities/server/catalogue-query";
import { mergeCoincidentTransitStops } from "@/features/amenities/server/merge-transit-stops";
import { withActiveDataset } from "@/features/amenities/server/catalogue-store";
import { datasetMatchesExtent, describeRegionMismatch } from "@/features/amenities/server/catalogue-region";
import { bandMinutes, LEGEND_BANDS, type Band } from "@/features/isochrones/bands";
import { CAR_FACTOR_REVISION, carTrafficSlotFor } from "@/features/isochrones/car-traffic";
import { DEFAULT_PACE, type Pace } from "@/features/isochrones/pace";
import { drivingIsochrone, walkingIsochrone } from "@/features/isochrones/server/ors";
import { transitIsochrone } from "@/features/isochrones/server/transit";
import { DEFAULT_TIME_CONTEXT, type TimeContext } from "@/features/isochrones/time-context";
import { effectivePace, type Mode } from "@/features/map/selection-flow";
import { getCachedSafe, setCachedSafe } from "@/lib/api-cache";
import { db } from "@/lib/db";
import { taggedCacheKey } from "@/lib/env";
import { ProviderError, roundCoord } from "@/lib/provider-http";

/**
 * What the amenity set was clipped to (task 065).
 *
 * Replaces the old `walkMinutes: 15`, which described a 15-minute WALK ring that
 * was used in EVERY mode — so in transit or car the payload named a boundary the
 * user was not looking at. The clip is now the outermost band of the CURRENT mode,
 * and `minutes` is that band's per-mode label (`bandMinutes`), so a car clip
 * honestly reads 30 rather than 45.
 */
export interface AmenityClip {
  mode: Mode;
  band: Band;
  minutes: number;
}

export interface NearbyAmenitiesResult {
  origin: { lat: number; lng: number };
  clip: AmenityClip;
  /**
   * TRUE pre-cap totals per (category, band) — the ONLY count contract.
   *
   * A flat whole-clip `counts` used to ride alongside this and was dropped in task 065's
   * no consumer read it (every displayed figure is derived by
   * summing the SHADED bands), yet leaving it in the payload invited a future reader to
   * wire the chips straight to it and silently reintroduce the "chips claim the whole
   * clip" bug this task removed. Anyone needing the whole-clip figure sums the bands.
   */
  countsByBand: AmenityCountsByBand;
  amenities: CatalogueAmenity[];
  catalogue: {
    sourceTimestamp: string | null;
    stale: boolean;
  };
}

/** Payload stored in ApiCache — freshness (`stale`) is recomputed on every read. */
interface CachedNearbyAmenities {
  origin: { lat: number; lng: number };
  clip: AmenityClip;
  countsByBand: AmenityCountsByBand;
  amenities: CatalogueAmenity[];
  sourceTimestamp: string | null;
  datasetId: string;
}

/** The three nested reach rings that bound and BAND the amenity set, ascending
 * (inner → outer). Ring geometries are cumulative polygons, not annuli — see
 * `bands.ts`. The outermost is the clip; all three are needed so each place can
 * be attributed to the innermost band it falls in. */
interface ClipRings {
  ascending: GeoJSON.Geometry[];
  outer: GeoJSON.Geometry;
}

/** The clip's cache identity + (when the provider had to run to produce it) the
 * rings it returned, so a resolved-departure clip never costs two calls. */
interface ResolvedClip {
  /** Everything that can change the clip GEOMETRY, in the result cache key. */
  identity: string;
  rings: ClipRings | null;
}

export const CATALOGUE_STALE_AFTER_MS = 10 * 24 * 60 * 60 * 1_000;

/**
 * Result-cache TTL for a successful nearby query. Shorter than the 10-day
 * catalogue stale window and the weekly importer so a reseed (new datasetId)
 * naturally misses. Errors are never written here (fail-through).
 */
export const AMENITY_RESULT_TTL_MS = 24 * 60 * 60 * 1_000;

/** Bump when the cached JSON shape changes. Includes datasetId so a publish
 * invalidates. v2 (task 047): merged-transit `members`. v3 (task 051): the walk
 * ring used for the clip is PACE-dependent, so the pace is part of the key —
 * Slow and Normal must never share a cache entry (or counts would be wrong).
 * v4 (task 064): the 3/5 km/h walking speeds resize the 15-minute clip ring, so
 * the SET of amenities in range changed at every origin.
 * v5 (task 065): the clip is no longer a 15-minute walk ring in every mode — it
 * is the outermost band of the CURRENT mode, rows carry a `band`, counts are
 * per-(category, band) and the payload's `walkMinutes` became `clip`. Every v4
 * entry describes a different question and must never be served (24h TTL). */
const AMENITY_RESULT_CACHE_PREFIX = "amenity:local:v5:";

/**
 * Result-cache key. `clipIdentity` carries everything that can move the clip
 * GEOMETRY — mode, effective pace, and (mode-dependent) the resolved transit
 * departure or the car traffic slot + factor revision.
 *
 * It is deliberately built from RESOLVED values, never from a preset id (the 059
 * rule): the transit departure rolls forward weekly on its own, and the car
 * factor table can be recalibrated, so a preset-keyed entry would serve amenities
 * clipped to rings that no longer exist.
 */
export function amenityResultCacheKey(
  datasetId: string,
  lat: number,
  lng: number,
  clipIdentity: string,
): string {
  // Config-tagged (task 007): the clipped amenity set is DERIVED from the
  // config-lifted ORS/transit rings + the geofence bbox, but the key carries
  // none of that — so a provider/region flip must re-namespace it too, else it
  // serves places banded by the old provider's rings for the full TTL.
  return taggedCacheKey(
    `${AMENITY_RESULT_CACHE_PREFIX}${datasetId}:${clipIdentity}:${roundCoord(lat)},${roundCoord(lng)}`,
  );
}

/**
 * Rings ascending by minutes, with the OUTERMOST as the clip.
 *
 * Selected **by position, never by a minute value**: band ids are fixed positions
 * but the minute LABELS are per-mode (car reads 10/20/30, `bands.ts`), so a
 * `minutes === 45` lookup — the shape of the pre-065 `WALK_CLIP_MINUTES` lookup —
 * would find nothing in car mode and fail every car amenity request.
 */
export function clipRingsFrom(
  rings: readonly { minutes: number; geometry?: unknown }[],
): ClipRings {
  const ascending = [...rings]
    .sort((a, b) => a.minutes - b.minutes)
    .map((r) => r.geometry as GeoJSON.Geometry | undefined);
  if (ascending.length !== LEGEND_BANDS.length || ascending.some((g) => !g)) {
    throw new ProviderError(
      `reach rings unusable for the amenity clip (need ${LEGEND_BANDS.length} ring geometries, got ${ascending.length})`,
    );
  }
  const geometries = ascending as GeoJSON.Geometry[];
  return { ascending: geometries, outer: geometries[geometries.length - 1]! };
}

/**
 * Resolve the clip's cache identity for a mode, fetching rings when — and only
 * when — the identity depends on what the provider returns.
 *
 * Transit is the asymmetric one: its rings are keyed by a departure that
 * `transitIsochrone` resolves INTERNALLY (strictly-future, rolling weekly), so the
 * only way to key the amenity cache against *the polygon that was actually drawn*
 * is to call the provider first and read the departure off its result. That call
 * is cache-first and single-flighted, so on the warm path (the normal case — the
 * ring fetch for the same selection runs alongside this one) it costs no upstream
 * request. The trade accepted knowingly: a COLD transit origin now waits for the
 * ring provider before it can probe its own result cache. The alternative —
 * re-deriving the departure here — can straddle the weekly roll and key a cache
 * entry to a polygon the user never saw.
 *
 * Walk and car need no such call: pace fully determines a walk ring, and a car
 * ring is determined by the traffic slot plus the factor-table revision (which is
 * in the key because a recalibration changes the geometry — `ors.ts` keys its own
 * car rings the same way).
 */
async function resolveClip(
  latRaw: number,
  lngRaw: number,
  mode: Mode,
  pace: Pace,
  timeContext: TimeContext,
): Promise<ResolvedClip> {
  switch (mode) {
    case "walk":
      return { identity: `walk:${pace}`, rings: null };
    case "car": {
      const slot = carTrafficSlotFor(timeContext);
      return { identity: `car:${CAR_FACTOR_REVISION}:${slot.slotId}`, rings: null };
    }
    case "transit": {
      const iso = await transitIsochrone(latRaw, lngRaw, pace, timeContext);
      return {
        identity: `transit:${pace}:${iso.departure}`,
        rings: clipRingsFrom(iso.rings),
      };
    }
  }
}

/**
 * Subtract the coincident-stop merge's absorbed duplicates from the per-band
 * transit counts (tasks 047 + 065).
 *
 * The catalogue query counts OSM nodes; the merge then fuses stops that are one
 * physical place (a bus+tram interchange, or spelling variants of one stop), so the
 * raw count would claim more distinct places than the map can possibly show. The
 * correction is applied **per band**, because a band's chip is now its own honest
 * figure — subtracting one clip-wide scalar would leave each band over-counting.
 *
 * **Gated on band completeness (`completeBands`).** Task 047 skipped the correction for a
 * capped category because its returned rows are an incomplete sample. Task 065 briefly
 * removed that gate, arguing the observable duplicates were "closer to the truth"; two
 * the gate is RESTORED, because a capped band would
 * otherwise mix a de-duplicated and a raw basis into one number that cannot be described
 * honestly. So: a **complete** band has its duplicates removed; a **capped** band reports
 * raw stop records. One basis per band.
 */
export function adjustTransitCountsForMerge(
  countsByBand: AmenityCountsByBand,
  bandAdjustments: ReadonlyMap<Band, number>,
  completeBands: ReadonlySet<Band>,
): AmenityCountsByBand {
  const out = {} as AmenityCountsByBand;
  for (const band of LEGEND_BANDS) {
    const inBand = countsByBand[band];
    // A NET decrement (see `mergeCoincidentTransitStops`): every member's band loses its
    // row and the innermost band gains one back for the surviving marker. It is always
    // ≥ 0 — a band's delta is (members in that band) − 1 only for the innermost band,
    // which by definition has at least one member — so the clamp below is belt-and-braces
    // rather than load-bearing.
    //
    // **Applied only to a band whose transit rows came back COMPLETE.** In a capped band
    // only the duplicates among the returned rows are observable, so subtracting them
    // would mix two bases — part de-duplicated, part raw — and produce a number that is
    // hard to state truthfully. Task 047 had this gate, task 065 removed it reasoning
    // the honest contract is one basis per band. A capped band therefore reports RAW stop records, some of which
    // may be the same physical place — see the Parked note for the proper fix (merge
    // before capping, which needs the coincident-stop rule inside SQL).
    const delta = completeBands.has(band) ? (bandAdjustments.get(band) ?? 0) : 0;
    out[band] = { ...inBand, transit: Math.max(0, inBand.transit - delta) };
  }
  return out;
}

/**
 * Fetch the clip rings for a mode when `resolveClip` did not already have them.
 *
 * Only walk and car reach here. `resolveClip` must call the transit provider to learn
 * the resolved departure for the cache key, so it ALWAYS returns transit's rings and a
 * transit call to this function is unreachable by construction — coverage flagged the
 * arm as dead, so rather than keep an untestable branch it now fails loud if the
 * invariant is ever broken by a refactor.
 */
async function clipRingsFor(
  latRaw: number,
  lngRaw: number,
  mode: Mode,
  pace: Pace,
  timeContext: TimeContext,
): Promise<ClipRings> {
  switch (mode) {
    case "walk":
      return clipRingsFrom((await walkingIsochrone(latRaw, lngRaw, pace)).rings);
    case "car":
      return clipRingsFrom(
        (await drivingIsochrone(latRaw, lngRaw, carTrafficSlotFor(timeContext))).rings,
      );
    case "transit":
      throw new ProviderError(
        "transit clip rings must come from resolveClip (it resolves the departure) — this path is unreachable",
      );
  }
}

export function isCatalogueStale(sourceTimestamp: Date | null, now = new Date()): boolean {
  if (!sourceTimestamp) return true;
  return now.getTime() - sourceTimestamp.getTime() > CATALOGUE_STALE_AFTER_MS;
}

export class CatalogueUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CatalogueUnavailableError";
  }
}

export function rehydrateCachedNearby(
  cached: CachedNearbyAmenities,
  now = new Date(),
): NearbyAmenitiesResult {
  let sourceOk: Date | null = null;
  if (cached.sourceTimestamp) {
    const parsed = new Date(cached.sourceTimestamp);
    if (!Number.isNaN(parsed.getTime())) sourceOk = parsed;
  }
  return {
    origin: cached.origin,
    clip: cached.clip,
    countsByBand: cached.countsByBand,
    amenities: cached.amenities,
    catalogue: {
      sourceTimestamp: sourceOk?.toISOString() ?? null,
      stale: isCatalogueStale(sourceOk, now),
    },
  };
}

// Concurrent cold callers for the same rounded origin share one catalogue
// query (and one ORS walk-ring fetch underneath), mirroring ORS single-flight.
const inFlight = new Map<string, Promise<NearbyAmenitiesResult>>();

/**
 * Amenities inside the reach area of `mode` at this origin.
 *
 * Runtime discovery uses the SAME reach provider the painted rings come from
 * (ORS walking / MOTIS transit / ORS driving) plus local PostGIS — so the markers
 * and the shading always describe one polygon.
 *
 * **Single-flight identity must match the clip's identity.** It used to be
 * `pace:coords`, which was correct while every mode shared one 15-minute walk
 * clip; now a Walk→Public-transport (or Crowded→Quiet) toggle landing mid-flight
 * would coalesce onto the in-flight computation and return **the wrong mode's
 * clip** — the same class of bug the pace was added to this key to prevent
 * (task 051). The preset id is the right granularity HERE (it answers "are these
 * two callers asking the same question?"); the RESULT CACHE key instead uses the
 * resolved departure/slot, because it answers "does this stored answer still match
 * the drawn polygon?" — those are different questions, hence deliberately
 * different keys.
 */
export async function nearbyAmenities(
  latRaw: number,
  lngRaw: number,
  pace: Pace = DEFAULT_PACE,
  mode: Mode = "walk",
  timeContext: TimeContext = DEFAULT_TIME_CONTEXT,
): Promise<NearbyAmenitiesResult> {
  const lat = Number(roundCoord(latRaw));
  const lng = Number(roundCoord(lngRaw));
  // Pace is a WALKING concept (task 052): the single source for "which pace does
  // this mode actually use" is `effectivePace`, reused rather than re-encoded so a
  // Slow pace left over from Walk can never leak into a transit or car clip.
  const clipPace = effectivePace(mode, pace);
  // The catalogue check comes FIRST: resolving the clip before it let
  // `mode=transit` call MOTIS — and answer 502 on a provider failure — when the
  // deterministic answer was "no active catalogue" (503). A cheap local read must not sit
  // behind an upstream call it can make unnecessary.
  const active = await db().amenityDataset.findUnique({
    where: { activeKey: 1 },
    select: { id: true, validation: true },
  });
  if (!active) throw new CatalogueUnavailableError("No active amenity catalogue");
  // Region cross-check (task 013), cheap OUTER early-out: refuse a dataset whose
  // recorded import bbox ≠ the resolved extent BEFORE the ORS/MOTIS ring call, so a
  // wrong-region catalogue answers a clean 503, never an honest-looking empty 200.
  // The AUTHORITATIVE check is repeated inside `withActiveDataset` below (a publish
  // can swap the active dataset between here and the pinned read — TOCTOU).
  if (!datasetMatchesExtent(active.validation)) {
    throw new CatalogueUnavailableError(describeRegionMismatch(active.validation));
  }

  // Resolve the clip identity BEFORE coalescing. It used to be keyed on the preset id,
  // which can coalesce two transit requests that straddle
  // the weekly strictly-future departure roll: same preset, different resolved departure,
  // so the second caller would receive amenities clipped to the ring the FIRST caller's
  // departure produced while its own rings were drawn for the new one. Keying on the
  // resolved identity closes that window and removes a duplicated key format — the flight
  // and the result cache now agree by construction. Cheap: for walk/car the identity is
  // pure arithmetic, and for transit the provider call it needs is itself cache-first and
  // single-flighted, so concurrent callers still cost one upstream request.
  const clip = await resolveClip(latRaw, lngRaw, mode, clipPace, timeContext);
  const flightKey = `${clip.identity}:${lat},${lng}`;

  const existing = inFlight.get(flightKey);
  if (existing) return existing;

  const promise = computeNearbyAmenities(
    latRaw,
    lngRaw,
    lat,
    lng,
    clipPace,
    mode,
    timeContext,
    clip,
    active.id,
  );
  inFlight.set(flightKey, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(flightKey);
  }
}

async function computeNearbyAmenities(
  latRaw: number,
  lngRaw: number,
  lat: number,
  lng: number,
  pace: Pace,
  mode: Mode,
  timeContext: TimeContext,
  clip: ResolvedClip,
  /** Resolved by the caller BEFORE the clip, so an unavailable catalogue never costs an
   * upstream ring call. Passed in rather than re-read: one probe per request. */
  activeDatasetId: string,
): Promise<NearbyAmenitiesResult> {
  // ApiCache probe OUTSIDE any long interactive transaction so cache hits never hold a
  // pool slot across a second client (pool starvation on concurrent warm origins).
  const cacheKey = amenityResultCacheKey(activeDatasetId, lat, lng, clip.identity);
  const hit = await getCachedSafe<CachedNearbyAmenities>(cacheKey);
  if (hit && hit.datasetId === activeDatasetId) {
    // Warm path: skip the catalogue query. Stale is recomputed at read time.
    return rehydrateCachedNearby(hit);
  }

  // Miss path: the reach rings bound AND band the query, then a pinned dataset read.
  // Server-side spans (task 017, gap #8) attribute the cold cost between the ORS reach-ring
  // fetch and the PostGIS intersect — the audit could only INFER the split by subtracting two
  // independently-sampled p95s (which don't subtract). Gated on AMENITY_SPANS so it's a
  // diagnostic, not always-on log noise. `clip.rings` is already present for transit (resolveClip
  // fetched them), so this ORS span is walk/car only — exactly the cold-cold probe's path.
  const spansOn = !!process.env.AMENITY_SPANS;
  const tStart = spansOn ? performance.now() : 0;
  const rings = clip.rings ?? (await clipRingsFor(latRaw, lngRaw, mode, pace, timeContext));
  const tAfterRings = spansOn ? performance.now() : 0;

  let summary: {
    datasetId: string;
    countsByBand: AmenityCountsByBand;
    amenities: CatalogueAmenity[];
    sourceTimestamp: Date | null;
  } | null;
  try {
    summary = await withActiveDataset(async (tx, datasetId) => {
      const result = await queryCatalogueSummaryInRing(tx, datasetId, rings.ascending, {
        lat,
        lng,
      });
      const dataset = await tx.amenityDataset.findUniqueOrThrow({
        where: { id: datasetId },
        select: { sourceTimestamp: true },
      });
      // The AUTHORITATIVE region cross-check (task 013) lives inside `withActiveDataset`
      // itself: it verifies the pinned dataset's region in the SAME snapshot before
      // running this callback, returning null on a mismatch (which maps to a 503
      // below). So a publish that swaps in a wrong-region dataset between the outer
      // early-out and this pinned read cannot serve its rows — no TOCTOU window, and
      // no per-caller re-check needed here.
      return {
        datasetId,
        countsByBand: result.countsByBand,
        amenities: result.amenities,
        sourceTimestamp: dataset.sourceTimestamp,
      };
    });
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new CatalogueUnavailableError("Amenity catalogue query failed", { cause: error });
  }
  if (!summary) throw new CatalogueUnavailableError("No active amenity catalogue");
  const tAfterQuery = spansOn ? performance.now() : 0;

  // Fuse coincident transit stops into single markers (task 047). Read-time only.
  const merged = mergeCoincidentTransitStops(summary.amenities);
  if (spansOn) {
    const orsMs = (tAfterRings - tStart).toFixed(0);
    const pgMs = (tAfterQuery - tAfterRings).toFixed(0);
    const mergeMs = (performance.now() - tAfterQuery).toFixed(0);
    // One line, no payloads (the [api:*] boundary-log convention, node [19]).
    console.log(`[amenities:spans] mode=${mode} ors_rings=${orsMs}ms postgis=${pgMs}ms merge=${mergeMs}ms places=${summary.amenities.length}`);
  }
  // `modes` is a server-only merge input; drop it so it never enters the client
  // payload/cache contract (a merged marker carries everything the popup needs in
  // `members`). (impl-panel finding F5.)
  const amenities: CatalogueAmenity[] = merged.amenities
    .map((a) => {
      const copy = { ...a };
      delete copy.modes;
      return copy;
    })
    // Re-sort by distance. The SQL already returns rows nearest-first, but the merge can
    // emit a representative from a farther row at a nearer member's position (it moves the
    // representative to the innermost BAND, which is not always the nearest row), so the
    // list could be off strict distance order by up to the merge span. The browse list and
    // the label sort key both read this order, so it is cheaper to restore it here than to
    // make every consumer defensive. Stable on ties.
    .sort((a, b) => a.distanceMeters - b.distanceMeters);
  // A band is COMPLETE when every transit row it counts actually came back (i.e. the
  // per-band cap did not bite), which is the only case where the merge sees every
  // duplicate. Counted on the PRE-merge rows, since that is what the totals describe.
  const completeBands = new Set<Band>(
    LEGEND_BANDS.filter((band) => {
      const returned = summary.amenities.filter(
        (a) => a.category === "transit" && a.band === band,
      ).length;
      return returned >= summary.countsByBand[band].transit;
    }),
  );
  const countsByBand: AmenityCountsByBand = adjustTransitCountsForMerge(
    summary.countsByBand,
    merged.transitBandAdjustments,
    completeBands,
  );

  const sourceIso = summary.sourceTimestamp?.toISOString() ?? null;
  // The clip is the OUTERMOST band, whose displayed minute is per-mode (a car's
  // outer band reads 30, not 45) — so this describes what the user is looking at.
  const outerBand = LEGEND_BANDS[LEGEND_BANDS.length - 1] as Band;
  const clipDescriptor: AmenityClip = {
    mode,
    band: outerBand,
    minutes: bandMinutes(mode, outerBand),
  };
  const payload: NearbyAmenitiesResult = {
    origin: { lat, lng },
    clip: clipDescriptor,
    countsByBand,
    amenities,
    catalogue: {
      sourceTimestamp: sourceIso,
      stale: isCatalogueStale(summary.sourceTimestamp),
    },
  };

  // Only successful results are stored. Empty markers are legitimate hits.
  const body: CachedNearbyAmenities = {
    origin: payload.origin,
    clip: clipDescriptor,
    countsByBand,
    amenities,
    sourceTimestamp: sourceIso,
    datasetId: summary.datasetId,
  };
  await setCachedSafe(
    amenityResultCacheKey(summary.datasetId, lat, lng, clip.identity),
    body,
    new Date(Date.now() + AMENITY_RESULT_TTL_MS),
  );

  return payload;
}
