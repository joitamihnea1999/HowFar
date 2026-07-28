/**
 * Amenity display geometry — the pure, MapLibre-free core of the "always
 * legible" contract (task 061).
 *
 * ## The load-bearing idea
 *
 * The owner's complaint was density: in a dense district up to 750 markers
 * (`MAX_PER_CATEGORY` × 5 categories) land inside one 15-min walk ring, and no
 * amount of icon polish makes 8 places readable inside 20px. So instead of
 * *reducing* crowding, this module's constants make readable-overlap
 * **structurally impossible**: the source clusters anything closer than
 * `CLUSTER_RADIUS_PX` at EVERY zoom (`clusterMaxZoom` is pinned to the map's own
 * maximum), so two marks can never render close enough to collide.
 *
 * ## Why centre separation is not enough (found in review)
 *
 * Supercluster only bounds the distance between cluster *centres*. That does NOT
 * imply the rendered *footprints* are disjoint — a donut sized by member count
 * can grow until two legally-separated centres still overlap visually, and a
 * zoom-scaled pin can outgrow the cluster radius. review caught this
 * independently, and it was the weakest point of the original design.
 *
 * ## What is actually guaranteed — stated precisely (found in review)
 *
 * The shipped guarantee is **non-intersection of rendered footprints**: for every
 * pair of visible marks, `distance ≥ rA + rB`. It is NOT "every pair is at least
 * N px apart" — two marks may render exactly tangent. An earlier version of this
 * file documented a minimum *gap* while every enforcement point (`marksOverlap`,
 * the merge criterion, the e2e) tested bare intersection, so the doc promised
 * more than the code delivered; the wording here is now the weaker, true one.
 *
 * The guarantee is **produced by `agglomerateClusters`**, which merges any
 * intersecting pair until none is left — not by choosing lucky constants. What the
 * constants do is keep that merge from being pathological: `MAX_MARK_FOOTPRINT_PX`
 * caps how wide a donut may grow (extra members grow the centre NUMBER, not the
 * ring), and both a max-size donut and a max-size hovered pin must stay inside
 * `CLUSTER_RADIUS_PX` — otherwise marks would be wider than the radius that
 * separates them and the display would collapse into one giant donut.
 * `assertMarkSeparationInvariant` is called from the unit tests, so tuning any
 * constant out of that envelope fails the build rather than shipping a regression.
 */

import { AMENITY_CATEGORIES, type AmenityCategoryKey } from "@/features/amenities/amenities";

/**
 * Supercluster grouping radius, in screen pixels. Any two amenities closer than
 * this at the current zoom are aggregated into one donut — the first line of
 * defence against crowding, and the envelope every mark's footprint must fit
 * inside (see `assertMarkSeparationInvariant`).
 *
 * Upper bound is real too: it must stay well under the ~140px spacing the
 * existing `stop-lines` e2e relies on between its east/south fixtures, or those
 * deliberately-separate markers would fuse.
 */
export const CLUSTER_RADIUS_PX = 46;

/**
 * The donut size budget: the widest a cluster mark may ever render, in px.
 *
 * Named for what it actually is (found in review). It was `MIN_MARK_SEPARATION_PX`,
 * which read as "no two marks are ever closer than this" — a promise nothing in
 * the codebase kept, since every enforcement point tests footprint intersection,
 * not a gap. This constant caps `clusterRadiusForCount`, so a 200-member cluster
 * is no wider than a 3-member one.
 */
export const MAX_MARK_FOOTPRINT_PX = 34;

/** Individual-pin radius by zoom. Fixed 7px at every zoom was one of the three
 * causes of the original complaint (a pin occupied the same footprint whether
 * you looked at 200m or 5km). Capped at `MAX_PIN_RADIUS_PX` so pin growth can
 * never breach the separation invariant. */
export const PIN_RADIUS_STOPS: readonly (readonly [zoom: number, radius: number])[] = [
  [11, 4],
  [13, 6],
  [15, 8.5],
  [17, 11],
  [19, 13],
];

/** The largest radius `pinRadiusForZoom` can return — the invariant's binding term. */
export const MAX_PIN_RADIUS_PX = PIN_RADIUS_STOPS[PIN_RADIUS_STOPS.length - 1][1];

/** Hover growth factor, applied on top of the zoom-interpolated radius. A hovered
 * pin is NOT exempt from the no-overlap guarantee: collision reserves the grown
 * size (see `pinFootprintRadius`), because a hover that regrew a cleared overlap
 * is still the defect this task removes. */
export const PIN_HOVER_SCALE = 1.4;

/** The pin's white outline, in px. MapLibre paints `circle-stroke-width` OUTSIDE
 * the radius, so it is part of the footprint — omitting it let pairs overlap by a
 * few px and still pass the "structural" e2e (found in review). These are the two
 * values `map-setup`'s `hoverCase` paints, kept here so the layer spec, the
 * collision pass and the e2e all measure the same pin. */
export const PIN_STROKE_PX = 1.75;
export const PIN_HOVER_STROKE_PX = 2.5;

/**
 * A pin's rendered footprint radius at a zoom — radius plus outline.
 *
 * The ONE formula for "how big is this pin", shared by the collision pass (which
 * passes `hovered: true` to reserve the worst case) and the e2e invariant (which
 * measures what is actually on screen). They disagreed before: collision used
 * `r × hover + 2` while the e2e used a bare `r`.
 */
export function pinFootprintRadius(zoom: number, hovered = false): number {
  const r = pinRadiusForZoom(zoom);
  return hovered ? r * PIN_HOVER_SCALE + PIN_HOVER_STROKE_PX : r + PIN_STROKE_PX;
}

/** The largest footprint any pin can present — a hovered pin at max zoom. */
export const MAX_PIN_FOOTPRINT_PX = MAX_PIN_RADIUS_PX * PIN_HOVER_SCALE + PIN_HOVER_STROKE_PX;

/** Donut geometry. `CLUSTER_MIN_RADIUS_PX` keeps a 2-member cluster comfortably
 * tappable; `CLUSTER_MAX_RADIUS_PX` is the cap that keeps the invariant true no
 * matter how many members a cluster holds. */
export const CLUSTER_MIN_RADIUS_PX = 12;
/** Padding between the drawn ring and the edge of the marker's box, per side. */
export const CLUSTER_MARKER_PAD_PX = 1;
export const CLUSTER_MAX_RADIUS_PX = MAX_MARK_FOOTPRINT_PX / 2 - CLUSTER_MARKER_PAD_PX;
/** Donut ring thickness (the coloured arc band). */
export const CLUSTER_RING_THICKNESS_PX = 5;

/** Cluster aggregation must never dissolve, so it is pinned to the map's own
 * maximum zoom — otherwise coincident places would separate into overlap exactly
 * where they are most coincident. The GeoJSON source's `maxzoom` must be
 * STRICTLY GREATER than this or MapLibre warns and clustering stops early
 * (review: the source default is 18, the map default is 22, so both must
 * be set explicitly — verified against `maplibre-gl/src/source/geojson_source`). */
export const MAP_MAX_ZOOM = 22;
export const CLUSTER_MAX_ZOOM = MAP_MAX_ZOOM;
export const AMENITY_SOURCE_MAX_ZOOM = MAP_MAX_ZOOM + 1;

/**
 * Piecewise-linear pin radius for a zoom, clamped at both ends. Mirrors what the
 * MapLibre `interpolate` expression does, so the pure tests and the rendered
 * layer cannot disagree about the footprint the invariant is calculated from.
 */
export function pinRadiusForZoom(zoom: number): number {
  const stops = PIN_RADIUS_STOPS;
  if (zoom <= stops[0][0]) return stops[0][1];
  const last = stops[stops.length - 1];
  if (zoom >= last[0]) return last[1];
  for (let i = 1; i < stops.length; i++) {
    const [z1, r1] = stops[i];
    const [z0, r0] = stops[i - 1];
    if (zoom <= z1) return r0 + ((zoom - z0) / (z1 - z0)) * (r1 - r0);
  }
  return last[1];
}

/** The MapLibre `interpolate` expression equivalent of `pinRadiusForZoom`, so
 * the layer spec is generated from the same stops the tests assert against. */
export function pinRadiusZoomExpression(): unknown[] {
  return ["interpolate", ["linear"], ["zoom"], ...PIN_RADIUS_STOPS.flatMap(([z, r]) => [z, r])];
}

/**
 * Pin radius including hover growth, as one valid MapLibre expression.
 *
 * The shape here is forced by two separate MapLibre rules, both of which rejected
 * more obvious formulations during this task:
 *
 * 1. A paint property may contain only ONE zoom-based `interpolate`/`step`, so
 *    `["case", hover, <interp>, <interp>]` throws at `addLayer` — which silently
 *    drops the entire layer.
 * 2. A zoom `interpolate` must be **top-level**, so wrapping it as
 *    `["*", <interp>, <hoverFactor>]` is rejected too ("`zoom` expression may only
 *    be used as input to a top-level step/interpolate").
 *
 * So: interpolate stays at the top, and the hover factor is applied INSIDE each
 * stop output. Both bugs passed shape-only assertions; the first was caught by
 * rendering in a browser and the second by MapLibre's own validator, which
 * `map-setup.test.ts` now runs over the real specs.
 */
export function pinRadiusHoverExpression(): unknown[] {
  const hoverFactor = ["case", ["boolean", ["feature-state", "hover"], false], PIN_HOVER_SCALE, 1];
  return [
    "interpolate",
    ["linear"],
    ["zoom"],
    ...PIN_RADIUS_STOPS.flatMap(([zoom, radius]) => [zoom, ["*", radius, hoverFactor]]),
  ];
}

/**
 * Donut radius for a member count — √-scaled so bigger clumps read as bigger,
 * then **hard-capped**. The cap is the point: beyond it, additional members are
 * communicated by the centre number, never by a wider ring, because an
 * uncapped radius would let two legally-separated centres overlap visually
 * (found in review).
 */
export function clusterRadiusForCount(count: number): number {
  if (!Number.isFinite(count) || count <= 1) return CLUSTER_MIN_RADIUS_PX;
  const grown = CLUSTER_MIN_RADIUS_PX + Math.sqrt(count - 1) * 2.4;
  return Math.min(CLUSTER_MAX_RADIUS_PX, grown);
}

/** One coloured segment of a cluster donut. */
export interface DonutArc {
  category: AmenityCategoryKey;
  count: number;
  color: string;
  /** SVG path `d` for this arc, in a viewBox centred on (0,0). */
  d: string;
  /** Sweep in degrees — the tests assert these sum to 360 for any non-empty input. */
  sweepDeg: number;
}

const CATEGORY_ORDER = AMENITY_CATEGORIES.map((c) => c.key);
const COLOR_BY_KEY = Object.fromEntries(AMENITY_CATEGORIES.map((c) => [c.key, c.color])) as Record<
  AmenityCategoryKey,
  string
>;

/** Per-category counts carried on a cluster feature by `clusterProperties`. */
export type ClusterCategoryCounts = Partial<Record<AmenityCategoryKey, number>>;

/**
 * Cluster feature properties → ordered, non-zero per-category counts.
 *
 * Zero-count categories are dropped so a donut shows only what is actually
 * there, and the order follows `AMENITY_CATEGORIES` (the legend order) so the
 * same mix always draws the same picture — a donut whose arcs reshuffled between
 * repaints would be unreadable.
 */
export function clusterCategoryCounts(props: Record<string, unknown>): { category: AmenityCategoryKey; count: number }[] {
  const out: { category: AmenityCategoryKey; count: number }[] = [];
  for (const key of CATEGORY_ORDER) {
    const raw = Number(props[key]);
    if (Number.isFinite(raw) && raw > 0) out.push({ category: key, count: Math.round(raw) });
  }
  return out;
}

/** Total members represented by a set of per-category counts. */
export function totalFromCounts(counts: readonly { count: number }[]): number {
  return counts.reduce((sum, c) => sum + c.count, 0);
}

/** Polar → cartesian on the donut's mid-ring, with 0° at 12 o'clock. */
function pointOnRing(radius: number, angleDeg: number): [number, number] {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return [radius * Math.cos(rad), radius * Math.sin(rad)];
}

/**
 * Per-category counts → SVG arc segments forming one ring.
 *
 * A single-category cluster is the special case that breaks naive arc maths: a
 * 360° arc has identical start and end points, which SVG renders as *nothing*.
 * It is emitted as two 180° half-arcs instead, so a pure-groceries cluster draws
 * a complete ring rather than vanishing.
 */
export function donutArcs(
  counts: readonly { category: AmenityCategoryKey; count: number }[],
  radius: number,
  thickness: number = CLUSTER_RING_THICKNESS_PX,
): DonutArc[] {
  const total = totalFromCounts(counts);
  if (total <= 0 || counts.length === 0) return [];
  const r = Math.max(1, radius - thickness / 2);

  const arc = (from: number, to: number): string => {
    const [x0, y0] = pointOnRing(r, from);
    const [x1, y1] = pointOnRing(r, to);
    const largeArc = to - from > 180 ? 1 : 0;
    return `M ${x0.toFixed(3)} ${y0.toFixed(3)} A ${r.toFixed(3)} ${r.toFixed(3)} 0 ${largeArc} 1 ${x1.toFixed(3)} ${y1.toFixed(3)}`;
  };

  if (counts.length === 1) {
    const only = counts[0];
    // Full ring as two halves — a single 0°→360° arc collapses to a no-op path.
    return [
      {
        category: only.category,
        count: only.count,
        color: COLOR_BY_KEY[only.category],
        d: `${arc(0, 180)} ${arc(180, 360)}`,
        sweepDeg: 360,
      },
    ];
  }

  const out: DonutArc[] = [];
  let cursor = 0;
  counts.forEach((entry, index) => {
    // Last arc closes the remainder exactly, so rounding can never leave a
    // hairline gap or push the total past 360.
    const sweep = index === counts.length - 1 ? 360 - cursor : (entry.count / total) * 360;
    out.push({
      category: entry.category,
      count: entry.count,
      color: COLOR_BY_KEY[entry.category],
      d: arc(cursor, cursor + sweep),
      sweepDeg: sweep,
    });
    cursor += sweep;
  });
  return out;
}

/** The quantities the size envelope relates. Overridable in tests so the guard can be
 * shown to fire; production always uses the module's own constants. */
export interface MarkEnvelope {
  maxPinFootprint: number;
  clusterRadius: number;
  maxMarkFootprint: number;
  donutFootprint: number;
  sourceMaxZoom: number;
  clusterMaxZoom: number;
}

/** A rendered mark's screen footprint, used by the separation assertions. */
export interface MarkFootprint {
  x: number;
  y: number;
  radius: number;
}

/** Axis-aligned bounds of a mark's footprint. */
export function markBounds(m: MarkFootprint): { minX: number; minY: number; maxX: number; maxY: number } {
  return { minX: m.x - m.radius, minY: m.y - m.radius, maxX: m.x + m.radius, maxY: m.y + m.radius };
}

/**
 * Do two rendered marks overlap?
 *
 * Deliberately **footprint**-based, not centre-based: centre distance was the
 * flawed proof review rejected (T4). Two marks are overlapping when
 * their circles intersect, which is what a user actually sees.
 *
 * Strictly `<`, so exactly-tangent marks are legal. That is the guarantee this
 * codebase actually enforces everywhere (found in review) — see the header note on
 * why it is deliberately not phrased as a minimum gap.
 */
export function marksOverlap(a: MarkFootprint, b: MarkFootprint): boolean {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy) < a.radius + b.radius;
}

/** Every overlapping pair in a rendered set — the e2e reports these verbatim so
 * a failure names the offending marks instead of just a boolean. */
export function overlappingPairs<T extends MarkFootprint>(marks: readonly T[]): [T, T][] {
  const pairs: [T, T][] = [];
  for (let i = 0; i < marks.length; i++) {
    for (let j = i + 1; j < marks.length; j++) {
      if (marksOverlap(marks[i], marks[j])) pairs.push([marks[i], marks[j]]);
    }
  }
  return pairs;
}

/**
 * Side length of a cluster marker's box, in CSS pixels.
 *
 * The single definition of a donut's rendered size: the controller sizes the DOM
 * element with it, and overlap resolution measures footprints with it. Keeping them
 * on one formula matters — the first cut sized the element as
 * `ceil(2r) + 2·pad` while agglomeration compared bare `r`, so donuts that
 * agglomeration considered safely tangent were visibly overlapping by ~2px, and the
 * e2e invariant failed on a collision the merge pass believed it had resolved.
 */
export function clusterMarkerSizePx(total: number): number {
  return Math.ceil(clusterRadiusForCount(total) * 2) + CLUSTER_MARKER_PAD_PX * 2;
}

/** The radius overlap is judged on: half the marker's real box, not the ring. */
export function clusterFootprintRadius(total: number): number {
  return clusterMarkerSizePx(total) / 2;
}

/** One cluster as the donut layer sees it, before overlap resolution. */
export interface ClusterCandidate {
  /** Supercluster ids merged into this mark (one, until agglomeration merges).
   * EMPTY for an unclustered pin participating in the collision pass. */
  ids: number[];
  /** Feature ids of unclustered PINS absorbed into this mark (found in review).
   * A pin only becomes part of a mark by being absorbed, so this is how the mark
   * can still list places that belong to no supercluster. */
  pinIds: number[];
  /** Screen position, in container pixels. */
  x: number;
  y: number;
  lng: number;
  lat: number;
  counts: { category: AmenityCategoryKey; count: number }[];
  total: number;
}

/**
 * Keep ONE tile generation's clusters (found in review).
 *
 * During a zoom, MapLibre retains the old zoom's tiles while the new zoom's load,
 * and `querySourceFeatures` reports whatever is loaded — so the same places come
 * back twice, once per generation, under different `cluster_id`s. Dedupe-by-id
 * cannot see that (the ids genuinely differ), both generations land in the same
 * screen area, and the merge pass fuses them into one donut showing roughly
 * DOUBLE the real count until the stale tiles evict. A donut that lies, even for
 * a few frames, is precisely the failure the donut exists to prevent.
 *
 * The generation is read from the tile a feature came from, not decoded out of the
 * cluster id: supercluster offsets ids by the point count, which the client does
 * not know, whereas the tile's own zoom is unambiguous. A candidate whose tile
 * zoom is unknown makes the whole set unpartitionable, so the fallback is to keep
 * everything — the pre-existing behaviour, i.e. never worse than before.
 *
 * Ties prefer the HIGHER zoom: mid-zoom-in the finer generation is the one the map
 * is heading to, and picking it makes the donuts settle early instead of jumping.
 */
export function pickClusterGeneration<T extends { tileZ: number | null }>(
  items: readonly T[],
  targetZ: number,
): T[] {
  const chosen = chooseGeneration(items, targetZ);
  return chosen === null ? [...items] : items.filter((item) => item.tileZ === chosen);
}

/**
 * Which generation `pickClusterGeneration` would keep, or null when the set cannot be
 * partitioned (empty, or any unknown tile zoom).
 *
 * Exposed separately because the CLUSTERS pick the generation and the unclustered pins
 * must then be held to that same one. Letting pins choose their own nearest generation
 * independently reintroduced the very bug the partition fixes: with clusters on the new
 * tiling and a stale pin the only member of the old one, the pin was "nearest to the
 * target among those present" and got absorbed into a donut that already counted it.
 */
export function chooseGeneration(
  items: readonly { tileZ: number | null }[],
  targetZ: number,
): number | null {
  if (items.length === 0) return null;
  if (items.some((item) => item.tileZ === null || !Number.isFinite(item.tileZ))) return null;
  let best: number | null = null;
  for (const { tileZ } of items) {
    const z = tileZ as number;
    if (best === null) {
      best = z;
      continue;
    }
    const d = Math.abs(z - targetZ);
    const bestD = Math.abs(best - targetZ);
    if (d < bestD || (d === bestD && z > best)) best = z;
  }
  return best;
}

/** Which tile a source feature came from. Enough to reason about COVERAGE, which is
 * what deciding between tile generations actually requires. */
export interface TileRef {
  z: number;
  x: number;
  y: number;
}

/**
 * Is `tile` inside the area of `other` (either may be the coarser one)?
 *
 * Tile pyramids are strictly nested, so containment is a shift: at each zoom step a
 * tile's index halves. This is exact, unlike comparing screen positions.
 */
export function tilesOverlap(a: TileRef, b: TileRef): boolean {
  const [fine, coarse] = a.z >= b.z ? [a, b] : [b, a];
  const shift = fine.z - coarse.z;
  return (fine.x >> shift) === coarse.x && (fine.y >> shift) === coarse.y;
}

/**
 * Narrow to one tile generation WITHOUT blanking areas the chosen generation has not
 * loaded yet.
 *
 * Dropping every other generation is right where the generations overlap (that overlap
 * IS the double count) and wrong where they do not: a zoom loads tiles progressively, so
 * a retained old tile can be the ONLY coverage for part of the viewport, and dropping it
 * made amenities briefly VANISH there.
 *
 * The decision is made on **tile coverage**, not on how close two marks happen to be on
 * screen. An earlier version used centroid proximity and four reviewers independently
 * showed why that is wrong: a coarse parent cluster can sit far from every one of its own
 * finer children (its centroid is their weighted average, which can land well outside
 * `nearRadius` of any of them), so proximity kept the parent AND its children and
 * double-counted exactly the places the partition exists to protect. Containment in the
 * tile pyramid answers the real question — "has the chosen generation loaded this area?"
 * — and it is exact.
 *
 * Extras are also deduped against EACH OTHER, so two stale generations covering the same
 * uncovered region cannot both survive and re-inflate a mark.
 */
export function resolveGenerations<T extends { tile: TileRef | null }>(
  items: readonly T[],
  targetZ: number,
): T[] {
  const chosen = chooseGenerationFromTiles(items, targetZ);
  if (chosen === null) return [...items];
  const kept = items.filter((item) => item.tile?.z === chosen);
  const chosenTiles = kept.map((item) => item.tile as TileRef);

  // The retention decision is made per TILE, then EVERY feature of a retained tile is
  // kept. Deciding it per feature loses data: a tile always overlaps itself, so an
  // "already represented by another stale tile" test drops every feature after the first
  // one from the same uncovered tile — i.e. it silently deleted amenities from exactly
  // the region it was meant to preserve (found in review).
  const key = (t: TileRef) => `${t.z}/${t.x}/${t.y}`;
  const staleTiles: TileRef[] = [];
  const seenTiles = new Set<string>();
  for (const item of items) {
    const tile = item.tile;
    if (!tile || tile.z === chosen) continue;
    if (seenTiles.has(key(tile))) continue;
    seenTiles.add(key(tile));
    // Covered by the chosen generation ⇒ its features are duplicate reports.
    if (chosenTiles.some((t) => tilesOverlap(tile, t))) continue;
    // Ground already held by another retained stale tile ⇒ keeping both would
    // double-count that region.
    if (staleTiles.some((t) => tilesOverlap(tile, t))) continue;
    staleTiles.push(tile);
  }
  const retained = new Set(staleTiles.map(key));
  const extras = items.filter((item) => item.tile && retained.has(key(item.tile)));
  return [...kept, ...extras];
}

/** The generation to prefer, chosen from tile zooms — nearest to `targetZ`, ties to the
 * finer tiling the map is heading toward. Null when it cannot be determined, in which
 * case callers keep everything (never worse than having no partition at all). */
export function chooseGenerationFromTiles(
  items: readonly { tile: TileRef | null }[],
  targetZ: number,
): number | null {
  return chooseGeneration(
    items.map((item) => ({ tileZ: item.tile ? item.tile.z : null })),
    targetZ,
  );
}

/** Sum two per-category count lists, preserving legend order. */
function mergeCounts(
  a: readonly { category: AmenityCategoryKey; count: number }[],
  b: readonly { category: AmenityCategoryKey; count: number }[],
): { category: AmenityCategoryKey; count: number }[] {
  const totals = new Map<AmenityCategoryKey, number>();
  for (const entry of [...a, ...b]) {
    totals.set(entry.category, (totals.get(entry.category) ?? 0) + entry.count);
  }
  return CATEGORY_ORDER.filter((key) => (totals.get(key) ?? 0) > 0).map((key) => ({
    category: key,
    count: totals.get(key) as number,
  }));
}

/**
 * Resolve donut-vs-donut overlap by MERGING, iteratively, until none is left.
 *
 * Why this exists: supercluster's `clusterRadius` bounds how far apart *member
 * points* may be to group, but it guarantees **nothing** about the distance between
 * the resulting cluster CENTROIDS — a centroid is a weighted average, so two
 * clusters can settle closer together than the radius that formed them. Choosing
 * good constants therefore cannot establish the no-overlap invariant; an
 * adversarial fixture found a real `cluster(15) ↔ cluster(5)` collision at z13.
 *
 * Merging (rather than nudging apart) is what keeps the display truthful: the
 * combined mark reports the exact SUM of its members' totals and the union of their
 * category breakdowns, and sits at their count-weighted centroid — which is the
 * same kind of quantity a cluster centroid already is. Displacing a donut instead
 * would put a mark where no places are.
 *
 * Unclustered PINS participate too (found in review). Supercluster only guarantees a
 * pin is farther than `clusterRadius` from a cluster's SEED, not from its centroid —
 * and a centroid is a weighted average that can drift toward that pin, so a donut and
 * a lone pin could overlap heavily while every donut-vs-donut pair was legal. Feeding
 * pins in as single-member candidates closes that hole with the same truthful-merge
 * semantics; the caller then suppresses any pin that got absorbed so it is not drawn
 * twice.
 *
 * Greedy and iterative: each pass merges the first overlapping pair it finds and
 * restarts, so the result is order-stable and **provably** overlap-free on exit.
 * Termination is structural rather than assumed: every merge replaces two marks with
 * one, so the mark count strictly decreases and at most `n-1` merges can occur — the
 * loop can only exit by finding no overlapping pair. An earlier version capped the
 * passes at a fixed 64, which meant the overlap-free claim silently became conditional
 * once more than ~64 marks were on screen (found in review); the bound is now
 * derived from the input size, so it can never truncate a real convergence.
 * Input sizes are small (tens of marks), so the O(n²) scan is irrelevant.
 */
export function agglomerateClusters(
  candidates: readonly ClusterCandidate[],
  radiusFor: (total: number) => number = clusterFootprintRadius,
): ClusterCandidate[] {
  let current = candidates.map((c) => ({
    ...c,
    ids: [...c.ids],
    pinIds: [...c.pinIds],
    counts: [...c.counts],
  }));
  // Sorted by x so the sweep below can stop early, and re-sorted after every merge so
  // that property holds for the whole run. It also makes the greedy order independent
  // of the caller's iteration order (which varies with the camera) — the controller
  // already sorted on the same key, so production behaviour is unchanged.
  const byPosition = (a: ClusterCandidate, b: ClusterCandidate) =>
    a.x - b.x || a.y - b.y || (a.ids[0] ?? a.pinIds[0] ?? 0) - (b.ids[0] ?? b.pinIds[0] ?? 0);
  current.sort(byPosition);

  // Each iteration removes one mark, so this bound cannot be reached before the
  // no-overlap exit; it exists only so a hypothetical NaN coordinate can't spin.
  const bound = candidates.length + 1;
  for (let pass = 0; pass < bound; pass++) {
    let merged = false;
    // Widest footprint present this pass. Any pair farther apart in x than
    // `ra + maxR` cannot intersect, and the array is x-sorted, so neither can any
    // pair beyond it — which is what makes the early `break` sound.
    let maxR = 0;
    for (const c of current) maxR = Math.max(maxR, radiusFor(c.total));
    outer: for (let i = 0; i < current.length; i++) {
      for (let j = i + 1; j < current.length; j++) {
        const a = current[i];
        const b = current[j];
        const ra = radiusFor(a.total);
        const rb = radiusFor(b.total);
        // The sweep: x-sorted input means everything past this j is farther still.
        // Without it the pass is a full O(n^2) scan on every animation frame, which an
        // reviewer correctly flagged as an unmeasured cost at the 750-place
        // worst case (where nothing merges, because unclustered pins are always at
        // least CLUSTER_RADIUS_PX apart — so it is exactly the case that used to pay
        // the full scan for nothing).
        if (b.x - a.x >= ra + maxR) break;
        if (Math.hypot(a.x - b.x, a.y - b.y) >= ra + rb) continue;

        const total = a.total + b.total;
        // Count-weighted so the merged mark sits nearer the denser side.
        const w = total > 0 ? a.total / total : 0.5;
        const combined: ClusterCandidate = {
          ids: [...a.ids, ...b.ids],
          pinIds: [...a.pinIds, ...b.pinIds],
          x: a.x * w + b.x * (1 - w),
          y: a.y * w + b.y * (1 - w),
          lng: a.lng * w + b.lng * (1 - w),
          lat: a.lat * w + b.lat * (1 - w),
          counts: mergeCounts(a.counts, b.counts),
          total,
        };
        current = current.filter((_, index) => index !== i && index !== j);
        current.push(combined);
        current.sort(byPosition); // keep the sweep's precondition true
        merged = true;
        break outer;
      }
    }
    if (!merged) break;
  }
  return current;
}

/**
 * The size envelope, as an executable assertion.
 *
 * `overrides` exist purely so the tests can prove the check FIRES (review,
 * review): asserting only that the shipped constants pass cannot distinguish a working
 * guard from one a refactor has quietly turned into a no-op. Production calls it with
 * no arguments and therefore with the real constants.
 *
 * This does NOT assert "no two marks overlap" — that is produced at runtime by
 * `agglomerateClusters` and checked on real rendered geometry by the e2e. What it
 * asserts is the envelope that keeps the merge pass sane: every mark a pin or a
 * donut can present must fit inside the clustering radius, and a donut must stay
 * inside its size budget. Tuning a constant out of that envelope fails the build
 * rather than shipping a display that merges everything into one blob (or grows
 * rings until legally-separated centres collide again).
 */
export function assertMarkSeparationInvariant(overrides: Partial<MarkEnvelope> = {}): void {
  const {
    maxPinFootprint = MAX_PIN_FOOTPRINT_PX,
    clusterRadius = CLUSTER_RADIUS_PX,
    maxMarkFootprint = MAX_MARK_FOOTPRINT_PX,
    donutFootprint = clusterMarkerSizePx(Number.MAX_SAFE_INTEGER),
    sourceMaxZoom = AMENITY_SOURCE_MAX_ZOOM,
    clusterMaxZoom = CLUSTER_MAX_ZOOM,
  } = overrides;
  const problems: string[] = [];
  // Worst-case pin = max zoom AND hovered, because that is the footprint the
  // collision pass reserves (a resting-only reservation let a hover regrow a
  // cleared overlap).
  if (2 * maxPinFootprint > clusterRadius) {
    problems.push(
      `hovered pin footprint ${2 * maxPinFootprint}px exceeds CLUSTER_RADIUS_PX ${clusterRadius}px`,
    );
  }
  if (maxMarkFootprint > clusterRadius) {
    problems.push(
      `MAX_MARK_FOOTPRINT_PX ${maxMarkFootprint}px exceeds CLUSTER_RADIUS_PX ${clusterRadius}px`,
    );
  }
  // Judged on the MARKER BOX (what the user sees), not the drawn ring — the two
  // differ by the marker padding, and comparing the wrong one let visibly
  // overlapping donuts pass as tangent.
  if (donutFootprint > maxMarkFootprint) {
    problems.push(
      `donut footprint ${donutFootprint}px exceeds MAX_MARK_FOOTPRINT_PX ${maxMarkFootprint}px`,
    );
  }
  if (sourceMaxZoom <= clusterMaxZoom) {
    problems.push(
      `source maxzoom ${sourceMaxZoom} must exceed clusterMaxZoom ${clusterMaxZoom} (MapLibre warns and clustering stops early)`,
    );
  }
  if (problems.length > 0) {
    throw new Error(`amenity mark separation invariant violated: ${problems.join("; ")}`);
  }
}
