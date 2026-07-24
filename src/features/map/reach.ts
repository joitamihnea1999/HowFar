import { booleanPointInPolygon } from "@turf/boolean-point-in-polygon";
import type { Feature, MultiPolygon, Polygon } from "geojson";

import type { ReachLeg, ReachPlan, ReachPoint } from "@/features/isochrones/server/transit-plan";
import type { Mode } from "@/features/map/selection-flow";

/**
 * Pure helpers for the right-click "how do I get there?" popup (task 052 D):
 * client-side reachability banding (point-in-polygon on the SAME rings the map
 * drew) and the display formatting of a MOTIS trip into human steps. Kept pure
 * and unit-tested so the popup controller only does DOM + fetch.
 */

interface RingLike {
  minutes: number;
  geometry: unknown;
}

/**
 * The smallest-minutes ring whose polygon contains `point` ([lng, lat]), or null
 * if none does. Runs against the rings the client already rendered (post speck
 * filter, post walk-union, at the displayed pace), so the answer can never
 * disagree with what the user sees (plan-panel P2). Bad/empty geometry is
 * skipped, not thrown.
 */
export function reachBand(point: [number, number], rings: RingLike[]): number | null {
  const ascending = [...rings].sort((a, b) => a.minutes - b.minutes);
  for (const ring of ascending) {
    const geometry = ring.geometry as Polygon | MultiPolygon | undefined;
    const coords = (geometry as { coordinates?: unknown })?.coordinates;
    if (!geometry || !Array.isArray(coords) || coords.length === 0) continue;
    try {
      const feature: Feature<Polygon | MultiPolygon> = { type: "Feature", properties: {}, geometry };
      if (booleanPointInPolygon(point, feature)) return ring.minutes;
    } catch {
      // Degenerate geometry — treat as "not in this band" and keep scanning.
    }
  }
  return null;
}

/** What a right-click should do, decided purely from the mode + the point's
 * band (impl T1/P2). Transit outside every ring is answered WITHOUT a provider
 * call; walk always shows a band answer (a null band = "outside walk reach").
 * Pure + unit-tested so the gate can't silently regress to always-fetch. */
export type ReachAction =
  | { kind: "walk"; band: number | null }
  | { kind: "car"; band: number | null }
  | { kind: "transit-unreachable" }
  | { kind: "transit"; band: number };

export function decideReach(mode: Mode, band: number | null): ReachAction {
  // Exhaustive over Mode (not a `string` fallthrough): a future 4th mode without
  // a case here is a compile error, not a silent walk-band regression — the same
  // exhaustiveness guarantee the task gave `isochronePath`/`modeWord` (impl F1).
  switch (mode) {
    case "car":
      return { kind: "car", band };
    case "walk":
      return { kind: "walk", band };
    case "transit":
      return band === null ? { kind: "transit-unreachable" } : { kind: "transit", band };
    default: {
      const _exhaustive: never = mode;
      return _exhaustive;
    }
  }
}

const MODE_LABELS: Record<string, string> = {
  WALK: "Walk",
  BUS: "Bus",
  TRAM: "Tram",
  SUBWAY: "Metro",
  METRO: "Metro",
  RAIL: "Train",
  REGIONAL_RAIL: "Train",
  COACH: "Coach",
  FERRY: "Ferry",
  TROLLEYBUS: "Trolleybus",
};

/** Human label for a MOTIS mode (e.g. SUBWAY → "Metro"). */
export function transitModeLabel(mode: string): string {
  const known = MODE_LABELS[mode.toUpperCase()];
  if (known) return known;
  // Title-case an unknown mode defensively (never render a raw enum).
  return mode.charAt(0).toUpperCase() + mode.slice(1).toLowerCase();
}

/** MOTIS uses "START"/"END" for the trip endpoints; give them human names. */
function stopLabel(name: string): string {
  if (name === "END" || name === "") return "your destination";
  if (name === "START") return "your start";
  return name;
}

/**
 * What a right-click asks the popup controller to render. Built in AppMap (which
 * holds the selection + stashed rings) and consumed by the popup controller
 * (which does the DOM + the transit fetch). Walk reach is resolved client-side to
 * a band here; transit carries a ready-built `/api/reach` URL to fetch.
 */
export type ReachRequest =
  | { kind: "hint"; coords: [number, number] }
  | { kind: "walk"; coords: [number, number]; band: number | null }
  // Car reach is resolved fully client-side to a drive band (no provider call),
  // like walk but with driving copy + an estimate caveat (task 053).
  | { kind: "car"; coords: [number, number]; band: number | null }
  // The clicked point is outside every drawn transit ring — answer WITHOUT a
  // provider call, so the popup never contradicts the painted reach (T1/P2).
  | { kind: "transit-unreachable"; coords: [number, number] }
  // Inside the `band`-minute ring: fetch the actual journey; `band` is shown so
  // the trip time is framed against the reach the user sees (P8).
  | { kind: "transit"; coords: [number, number]; band: number; url: string };

/** A popup step: two lines of already-safe text (rendered via textContent). */
export interface ReachStep {
  primary: string;
  secondary: string;
}

/**
 * Format a planned trip's legs into display steps. WALK legs read "Walk N min /
 * to <place>"; transit legs read "<Mode> <line> → <headsign> / Board at <stop> ·
 * N min". Untrusted OSM names/headsigns are returned as plain strings and MUST be
 * rendered with textContent by the caller (never innerHTML).
 */
export function buildReachSteps(legs: ReachLeg[]): ReachStep[] {
  return legs.map((leg) => {
    if (leg.mode === "WALK") {
      return { primary: `Walk ${leg.minutes} min`, secondary: `to ${stopLabel(leg.toName)}` };
    }
    const label = transitModeLabel(leg.mode);
    const line = leg.line ? ` ${leg.line}` : "";
    const headsign = leg.headsign ? ` → ${leg.headsign}` : "";
    return {
      primary: `${label}${line}${headsign}`,
      // Show BOTH endpoints — the rider needs to know where to get off, not only
      // where to board (impl-panel: board/alight emphasis).
      secondary: `Board ${stopLabel(leg.fromName)} → alight ${stopLabel(leg.toName)} · ${leg.minutes} min`,
    };
  });
}

const NON_TRANSIT_MODES = new Set(["WALK", "BIKE", "BICYCLE", "CAR", "CAR_PARKING", "RENTAL", "SCOOTER", "ODM"]);

/** True when the plan has at least one public-transport leg — i.e. something
 * worth drawing + decluttering for. `bestPlan` can fall back to a `direct`
 * walk-OR-BIKE itinerary (transit-plan `bestPlan`), so gating the visual
 * treatment on `!isWalkOnly` would wrongly draw a bike route and label it "By
 * public transport" (impl-panel:). Any non-{walk,bike,car,…} mode
 * counts, so an unknown genuine transit mode still draws. */
export function hasTransitLeg(legs: ReachLeg[]): boolean {
  return legs.some((l) => !NON_TRANSIT_MODES.has(l.mode.toUpperCase()));
}

// --- Drawable journey model (task 054) ------------------------------------
// Pure derivation of what the map draws for a right-click transit journey: the
// leg lines and the stops the rider actually uses (board → transfer(s) →
// alight). Kept here (unit-tested) rather than in the coverage-excluded draw
// controller (plan-panel: the classification must have a pure home). The step
// list from `buildReachSteps` is 1:1 with `legs`, so a popup step's index maps
// straight to `journeyLegs(...).index` for the hover→highlight link.

export type ReachStopKind = "board" | "transfer" | "alight";

/** A stop the rider uses, in journey order. `legIndex` is the transit leg that
 * touches it (its board leg; for a same-stop transfer, the earlier leg). */
export interface ReachJourneyStop {
  lat: number;
  lng: number;
  name: string;
  kind: ReachStopKind;
  legIndex: number;
}

/** A leg to draw as a line: its coordinates (the decoded `path`, or a straight
 * from→to fallback when the path was empty/budget-dropped so a transfer/egress
 * is never silently missing), whether it is a walking leg (for dashed styling),
 * and its index in the `legs` array (== popup step index). */
export interface ReachJourneyLeg {
  index: number;
  isWalk: boolean;
  coords: [number, number][];
}

function coincident(a: ReachPoint, b: ReachPoint): boolean {
  // ~1e-6° ≈ 0.1 m: a genuine platform transfer shares the exact stop node, a
  // walk-transfer lands metres away — this separates the two.
  return Math.abs(a.lat - b.lat) < 1e-6 && Math.abs(a.lng - b.lng) < 1e-6;
}

function betterName(a: string, b: string): string {
  // Prefer a real stop name over the trip-endpoint sentinels / empty.
  const bad = (n: string) => n === "" || n === "START" || n === "END";
  if (bad(a)) return bad(b) ? a : b;
  return a;
}

/** Draw model for each leg: real path when present, else a straight from→to
 * segment; legs with no usable coords at all are dropped. Index preserved. */
export function journeyLegs(legs: ReachLeg[]): ReachJourneyLeg[] {
  const out: ReachJourneyLeg[] = [];
  legs.forEach((leg, index) => {
    let coords: [number, number][] = Array.isArray(leg.path) && leg.path.length >= 2 ? leg.path : [];
    if (coords.length < 2 && leg.from && leg.to) {
      coords = [
        [leg.from.lng, leg.from.lat],
        [leg.to.lng, leg.to.lat],
      ];
    }
    if (coords.length >= 2) out.push({ index, isWalk: leg.mode === "WALK", coords });
  });
  return out;
}

/**
 * The stops the rider actually uses, in order: the board + alight of every
 * TRANSIT leg, deduped ONLY when the alight of one leg and the board of the next
 * are the exact same node (a platform transfer) — a walk-transfer between
 * distinct stops keeps BOTH (so dot count is 2·transfers+2 there, not the naive
 * transfers+2). First = board, last = alight, the rest = transfer.
 */
export function journeyStops(legs: ReachLeg[]): ReachJourneyStop[] {
  type Raw = { pt: ReachPoint; name: string; legIndex: number };
  const raw: Raw[] = [];
  legs.forEach((leg, index) => {
    if (leg.mode === "WALK") return; // only vehicle legs contribute used stops
    if (leg.from) raw.push({ pt: leg.from, name: leg.fromName, legIndex: index });
    if (leg.to) raw.push({ pt: leg.to, name: leg.toName, legIndex: index });
  });
  // Collapse a consecutive coincident alight→board pair into one transfer node.
  const merged: Raw[] = [];
  for (const r of raw) {
    const prev = merged[merged.length - 1];
    if (prev && coincident(prev.pt, r.pt)) {
      prev.name = betterName(prev.name, r.name);
      continue;
    }
    merged.push({ ...r });
  }
  return merged.map((r, i) => ({
    lat: r.pt.lat,
    lng: r.pt.lng,
    name: r.name,
    legIndex: r.legIndex,
    kind: i === 0 ? "board" : i === merged.length - 1 ? "alight" : "transfer",
  }));
}

/** One-line summary for a trip header: "~57 min · 1 transfer" (pluralised). */
export function reachSummary(plan: Extract<ReachPlan, { reachable: true }>): string {
  const t = plan.transfers;
  const transfers = t === 0 ? "no transfers" : t === 1 ? "1 transfer" : `${t} transfers`;
  return `~${plan.totalMinutes} min · ${transfers}`;
}

/** A planned trip with no transit leg is really walking directions — label it
 * "On foot", not "By public transport" (impl-panel T4). */
export function isWalkOnly(legs: ReachLeg[]): boolean {
  return legs.length > 0 && legs.every((l) => l.mode === "WALK");
}

/** Walk-mode reach copy from a band (or null = outside the walk area). */
export function walkReachText(band: number | null): { title: string; detail: string } {
  if (band === null) {
    return { title: "Outside your walking reach", detail: "This point is beyond your mapped walk area." };
  }
  return { title: "On foot", detail: `Within about ${band} minutes' walk of your start.` };
}

/** Car-mode reach copy from a drive band (or null = outside the drive area).
 * Carries the estimate/no-live-traffic caveat, since the reach popup renders
 * this copy directly (not just SelectionCard) — plan-panel C-F. */
export function carReachText(band: number | null): { title: string; detail: string } {
  if (band === null) {
    return { title: "Beyond your driving reach", detail: "This point is outside your mapped drive area." };
  }
  return {
    title: "By car",
    detail: `Within about ${band} minutes' drive of your start — an estimate, without live traffic.`,
  };
}
