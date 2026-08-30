import {
  AMENITY_CATEGORIES,
  deriveTransitModes,
  emptyCountsByBand,
  MAX_PER_CATEGORY_PER_BAND,
  type Amenity,
  type AmenityCounts,
  type AmenityCountsByBand,
} from "@/features/amenities/amenities";
import { LEGEND_BANDS, type Band } from "@/features/isochrones/bands";
import type { Prisma } from "@/generated/prisma/client";

export interface CatalogueAmenity extends Amenity {
  id: string;
  distanceMeters: number;
  band: Band;
}

type CatalogueRow = {
  id: string;
  name: string | null;
  category: Amenity["category"];
  sourceType: string;
  sourceId: bigint;
  lat: number;
  lng: number;
  distanceMeters: number;
  band: number | string;
  transitTags: Record<string, string> | null;
};

type SummaryRow = CatalogueRow & { categoryTotal: number; bandTotal: number };

export type CatalogueRingSummary = {
  /** Pre-cap totals per category over the WHOLE clip. */
  counts: AmenityCounts;
  /** Pre-cap totals per category per band — what honest chips are summed from. */
  countsByBand: AmenityCountsByBand;
  amenities: CatalogueAmenity[];
};

/**
 * Grid cell used to spread marker admission across a band, in degrees.
 *
 * ~0.005° is ≈400 m north–south and ≈550 m east–west at Bucharest's latitude.
 * Chosen so it *matters* where it needs to: the outer band of a transit or car
 * reach spans many kilometres and therefore thousands of cells, so a cap of N
 * admits places from N different cells spread across the whole band instead of N
 * places clustered on its inner rim. In a small band (a 15-minute walk is ~1.2 km
 * across ≈ a handful of cells) there are fewer cells than the cap, so admission
 * degrades gracefully back to plain nearest-first — which is the right behaviour
 * there. Deliberately coarse: it is a spreading device, not a display grid, and a
 * fine grid would just reproduce distance ordering.
 */
export const AMENITY_STRATIFY_GRID_DEG = 0.005;

/**
 * Number of equal-count DISTANCE strata each (category, band) is split into before
 * the cap is applied. Admission then round-robins across strata, so each contributes
 * roughly `cap / AMENITY_DISTANCE_STRATA` markers.
 *
 * **Why this exists, measured rather than assumed.** The grid buckets above were
 * originally the whole stratification story, and at real density they were not
 * enough: within `bucket_rank = 1` the ordering was still `distance`, so when a band
 * holds far more grid cells than the cap, the admitted set is the *nearest N cells* —
 * origin-hugging all over again. Measured on the real 8.7k-place catalogue with a cap
 * of 100 and no strata: of the places available in the OUTER QUARTILE of the reach,
 * the query returned **3%** at a central transit origin (10 of 289), 8% and 10% at
 * two others. That is the exact complaint this task exists to fix, reproduced inside
 * the new clip — so the grid was demoted to a de-clumping device and distance strata
 * were added to guarantee far coverage.
 *
 * 10 is chosen so the farthest ~10% of places in every band always get ~10% of that
 * band's markers, which is a claim about the data rather than about geometry (equal
 * COUNT, not equal area) — the honest version, since a band's area is mostly far from
 * the origin while its places are mostly near.
 */
export const AMENITY_DISTANCE_STRATA = 10;

function toBand(value: number | string): Band {
  // The SQL CASE can only emit one of the three band ids; this narrows the driver's
  // value back to `Band` and fails loud rather than silently mislabelling.
  //
  // `Number(...)` is not defensive padding: the band ids reach Postgres as bound
  // parameters inside a CASE, so their result type is inferred as text and the
  // driver hands them back as STRINGS ("15"), not numbers. The SQL casts to integer
  // for exactly this reason; the coercion here keeps a driver/type-inference change
  // from turning into a hard failure at runtime. Caught by the real-PostGIS
  // integration test — no amount of mocking would have surfaced it.
  const numeric = Number(value);
  const band = LEGEND_BANDS.find((b) => b === numeric);
  if (!band) throw new TypeError(`catalogue query returned an unknown band: ${value}`);
  return band;
}

function mapRow(row: CatalogueRow): CatalogueAmenity {
  const amenity: CatalogueAmenity = {
    id: row.id,
    lat: row.lat,
    lng: row.lng,
    name: row.name ?? "",
    category: row.category,
    osmType: row.sourceType,
    osmId: Number(row.sourceId),
    distanceMeters: row.distanceMeters,
    band: toBand(row.band),
  };
  // Transit stops carry their OSM mode set so the coincident-stop merge (task
  // 047) can distinguish an interchange from two same-mode platforms.
  if (row.category === "transit") amenity.modes = deriveTransitModes(row.transitTags);
  return amenity;
}

/**
 * One SQL snapshot produces the pre-cap totals (per category AND per band) plus the
 * markers to render, for the whole reach area of the current mode.
 *
 * This is the sole runtime clip path: it intersects each stored geometry with the
 * server-owned OUTER reach ring, derives an in-area display point, measures
 * geographic distance from the origin, attributes each place to a band, and caps
 * per (category, band). Because production and the boundary-clipping integration
 * test both call it, a regression in the display-point derivation cannot ship green.
 *
 * Three decisions here are load-bearing and were all wrong in the first draft of
 * task 065's plan:
 *
 * 1. **Band comes from the geometry, not from the display point.** A park can span
 *    bands 15→45; its `ST_PointOnSurface` might land in band 30, and filtering the
 *    rings to 15 would then hide a park the user can plainly see inside the shaded
 *    15-minute area. So the band is the INNERMOST ring the geometry intersects.
 * 2. **Admission inside a band is spatially stratified, not nearest-first.**
 *    `ORDER BY distance` alone fills each band from its inner rim, so the outer
 *    kilometres of a transit/car reach would stay marker-empty even though the
 *    catalogue has places there. Rows are bucketed onto a coarse grid and admitted
 *    in bucket-rank order (every bucket's nearest first, then second, …), which
 *    spreads coverage while still preferring the nearest place within any bucket.
 * 3. **Counts stay PRE-cap and are reported per band.** The default ring filter
 *    shades one band, so a whole-clip total would overclaim in the default view.
 *
 * Membership is defined by the OUTER ring alone. Reach rings are nested by
 * construction (ORS ranges, MOTIS contours, and `dropSmallComponents` preserves
 * nesting), so unioning the three would cost geometry work per query to defend
 * against a provider-contract violation that should be fixed upstream rather than
 * papered over here.
 */
export async function queryCatalogueSummaryInRing(
  tx: Prisma.TransactionClient,
  datasetId: string,
  rings: readonly GeoJSON.Geometry[],
  origin: { lat: number; lng: number },
): Promise<CatalogueRingSummary> {
  if (rings.length !== LEGEND_BANDS.length) {
    throw new TypeError(
      `Amenity clip needs ${LEGEND_BANDS.length} nested rings (inner→outer), got ${rings.length}`,
    );
  }
  for (const ring of rings) {
    if (ring.type !== "Polygon" && ring.type !== "MultiPolygon") {
      throw new TypeError("Amenity ring must be a Polygon or MultiPolygon");
    }
  }
  const [innerRing, midRing, outerRing] = rings as [
    GeoJSON.Geometry,
    GeoJSON.Geometry,
    GeoJSON.Geometry,
  ];
  const [innerBand, midBand, outerBand] = LEGEND_BANDS;

  const rows = await tx.$queryRaw<SummaryRow[]>`
    WITH params AS (
      SELECT
        ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(innerRing)}), 4326) AS ring_inner,
        ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(midRing)}), 4326) AS ring_mid,
        ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(outerRing)}), 4326) AS ring_outer,
        ST_SetSRID(ST_Point(${origin.lng}, ${origin.lat}), 4326) AS origin
    ), intersections AS MATERIALIZED (
      -- MATERIALIZED (task 017, gap #8) — the load-bearing perf fix, EXPLAIN-justified. The band
      -- column is a nested ST_Intersects(geom, ring_inner/mid) CASE. Without materialization
      -- Postgres INLINES this CTE, so band (and the geography ST_Distance downstream) get
      -- re-evaluated inside every window-function sort key (bucketed/stratified/ranked all
      -- PARTITION/ORDER on category, band, distance). Measured on the real 8.7k-place dataset:
      -- inlined 457 ms vs materialized 100 ms (3-4.5x), ALL from cutting recomputation — the
      -- buffers were already shared-hit (warm), so this is CPU, not I/O (a startup warmup that
      -- only warmed shared_buffers did NOT move it — the incomplete first EXPLAIN missed this).
      -- Materializing intersections computes band+geom once; clipped_rows below holds the
      -- ST_Intersection result once. Output is IDENTICAL (a plan hint) — proven by diffing the
      -- returned rows with/without the hint (942==942) and by the catalogue integration test.
      --
      -- The rings + origin from params are USED here (band) but NOT projected forward, and
      -- clipped_rows/measured re-CROSS JOIN the 1-row params for what they need — so the
      -- materialized tuplestore never stores the 3 ring polygons per row (which would be ~2× the
      -- reach's ring bytes × N rows, spilling to temp files on a big car/transit reach).
      SELECT
        place.id,
        place.name,
        place.category,
        place."sourceType",
        place."sourceId",
        place."sourceTags",
        place.geom,
        -- The band is decided on the FULL stored geometry, so a park straddling a
        -- ring boundary is attributed to the innermost band it reaches into.
        (CASE
          WHEN ST_Intersects(place.geom, params.ring_inner) THEN ${innerBand}
          WHEN ST_Intersects(place.geom, params.ring_mid) THEN ${midBand}
          ELSE ${outerBand}
        END)::integer AS band
      FROM "osm_catalogue"."AmenityPlace" AS place
      CROSS JOIN params
      WHERE place."datasetId" = ${datasetId}
        AND ST_Intersects(place.geom, params.ring_outer)
    ), clipped_rows AS MATERIALIZED (
      -- MATERIALIZED with intersections above (task 017) — holds the per-row ST_Intersection
      -- clip once so the downstream ST_PointOnSurface/window sorts don't re-run it. Re-joins the
      -- 1-row params for the band's ring rather than carrying it forward from intersections.
      SELECT
        intersections.*,
        -- Clip to the ring of the band this row was ATTRIBUTED to — not to the outer
        -- ring. Clipping to the outer ring was a defect: a park that touches ring 15 but whose bulk lies
        -- further out would take a display point out there, so at the default inner-band
        -- filter its marker drew OUTSIDE the shaded 15-minute area. That is the exact
        -- inverse of the vanishing-park bug the band attribution fixed, and it breaks
        -- this task's own acceptance rule ("no marker outside the shading").
        --
        -- A POINT that passed ST_Intersects IS its own clip, so it skips the
        -- intersection entirely — and safely: for a point, "intersects" means
        -- "contained", so a point attributed to band 15 is already inside ring 15. Most
        -- catalogue rows are point nodes (3.7k of 8.7k are transit stops alone), and
        -- computing a polygon intersection for each was measurable dead work.
        CASE
          WHEN GeometryType(geom) = 'POINT' THEN geom
          WHEN band = ${innerBand} THEN ST_Intersection(geom, params.ring_inner)
          WHEN band = ${midBand} THEN ST_Intersection(geom, params.ring_mid)
          ELSE ST_Intersection(geom, params.ring_outer)
        END AS clipped
      FROM intersections
      CROSS JOIN params
    ), display_points AS (
      SELECT clipped_rows.*, ST_PointOnSurface(clipped) AS display_point
      FROM clipped_rows
      WHERE NOT ST_IsEmpty(clipped)
    ), measured AS (
      SELECT
        id,
        name,
        category,
        "sourceType",
        "sourceId",
        band,
        -- Only transit rows need their tags downstream (mode derivation); other
        -- categories carry NULL so the payload isn't bloated with raw OSM tags.
        CASE WHEN category = 'transit' THEN "sourceTags" ELSE NULL END AS "transitTags",
        ST_Y(display_point)::double precision AS lat,
        ST_X(display_point)::double precision AS lng,
        ST_Distance(display_point::geography, params.origin::geography)::double precision AS distance,
        ST_SnapToGrid(display_point, ${AMENITY_STRATIFY_GRID_DEG}) AS bucket
      FROM display_points
      -- Re-join the 1-row params for origin + the band ring (not carried through the tuplestore).
      CROSS JOIN params
      -- Belt-and-braces: the display point must sit inside the ring of its own band,
      -- which is what makes "no marker outside the shading" true at EVERY filter, not
      -- only at "all".
      WHERE ST_Covers(
        CASE WHEN band = ${innerBand} THEN params.ring_inner WHEN band = ${midBand} THEN params.ring_mid ELSE params.ring_outer END,
        display_point
      )
    ), bucketed AS (
      SELECT
        measured.*,
        -- Rank inside the grid cell: 1 = this cell's nearest place. Collapses dense
        -- clumps so one shop-lined junction cannot spend the whole cap.
        ROW_NUMBER() OVER (
          PARTITION BY category, band, ST_AsBinary(bucket)
          ORDER BY distance, id
        ) AS bucket_rank,
        -- Distance STRATUM inside the band (1 = nearest slice … N = farthest slice),
        -- by equal COUNT of places. This is what makes far coverage guaranteed rather
        -- than hoped for — see the header note on why the grid alone was not enough.
        -- The ::int cast is required, not cosmetic: Prisma binds this as an untyped
        -- parameter and Postgres cannot infer a type for NTILE's argument
        -- (it reports "there is no parameter" and the whole query fails), so the
        -- cast is what makes this a valid window function call.
        NTILE(${AMENITY_DISTANCE_STRATA}::int) OVER (
          PARTITION BY category, band
          ORDER BY distance, id
        ) AS stratum
      FROM measured
    ), stratified AS (
      SELECT
        bucketed.*,
        -- Rank within a stratum: cell-spread first, then nearest.
        ROW_NUMBER() OVER (
          PARTITION BY category, band, stratum
          ORDER BY bucket_rank, distance, id
        ) AS in_stratum_rank
      FROM bucketed
    ), ranked AS (
      SELECT
        stratified.*,
        COUNT(*) OVER (PARTITION BY category)::integer AS category_total,
        COUNT(*) OVER (PARTITION BY category, band)::integer AS band_total,
        -- ROUND-ROBIN across strata: take each stratum's best candidate before any
        -- stratum's second. With a cap of C over N strata every stratum contributes
        -- ~C/N markers, so the farthest slice of a band is represented no matter how
        -- many places crowd the inner slices.
        ROW_NUMBER() OVER (
          PARTITION BY category, band
          ORDER BY in_stratum_rank, stratum, distance, id
        ) AS band_rank
      FROM stratified
    )
    SELECT
      id,
      name,
      category,
      "sourceType",
      "sourceId",
      "transitTags",
      band,
      lat,
      lng,
      distance AS "distanceMeters",
      category_total AS "categoryTotal",
      band_total AS "bandTotal"
    FROM ranked
    WHERE band_rank <= ${MAX_PER_CATEGORY_PER_BAND}
    ORDER BY distance, category, id
  `;

  const counts = Object.fromEntries(
    AMENITY_CATEGORIES.map(({ key }) => [key, 0]),
  ) as AmenityCounts;
  const countsByBand = emptyCountsByBand();
  for (const row of rows) {
    counts[row.category] = row.categoryTotal;
    countsByBand[toBand(row.band)][row.category] = row.bandTotal;
  }
  return { counts, countsByBand, amenities: rows.map(mapRow) };
}
