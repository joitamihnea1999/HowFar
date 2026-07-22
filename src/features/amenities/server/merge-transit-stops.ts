import type { Amenity, TransitStopMember } from "@/features/amenities/amenities";
import { normalizeAmenityName } from "@/features/amenities/server/catalogue-normalize";

/**
 * Merge coincident transit-stop markers into one (task 047). The catalogue
 * ingests every OSM `bus_stop`/`tram_stop`/`station` node separately, so one
 * physical place surfaces as several markers — a bus + tram interchange, or the
 * same stop under spelling variants. This read-time pass (the immutable
 * catalogue and the ODbL export stay untouched) fuses those into a single marker
 * that carries its members so the popup can union all their serving lines.
 *
 * CONSERVATIVE by owner decision: when unsure, keep separate. Radii are
 * calibrated on real Bucharest data — genuine coincident stops sit ≤~15m apart
 * (Savinesti tram/tram 14.6m; Vitan-Bârzești cross-mode ~3m), while genuinely
 * distinct stops (opposite kerbs, same-street-different-stop) sit ≥26m apart —
 * so 18m merges the former with headroom while staying 8m clear of the floor.
 */

const R_CROSS_M = 18; // different mode sets — a bus and a tram can't be opposite directions of one line
const R_SAME_M = 18; // identical mode sets — additionally requires an exact normalized-name match
// Reject a component whose members span farther than this. Kept BELOW the 26m
// "genuinely distinct" floor (the Stadionul Dinamo opposite-kerb pair) so no
// chain of ≤18m edges — e.g. a mid-road stop bridging the two kerbs — can ever
// fuse a pair the calibration keeps separate, while still clearing the observed
// ~17m diameter of the real Savinesti/Stadion cluster. (impl-panel finding F1.)
const MAX_SPAN_M = 24;

// Leading OSM street generics that don't change stop identity: "Șoseaua Vitan-
// Bârzești" ≡ "Sos. Vitan Barzesti". Applied AFTER normalizeAmenityName folds
// diacritics (ș→s) and lowercases, so only ascii forms are needed here. Never
// includes head words that DO distinguish (Pod/Cartier/Complex/Stadion/…).
const STREET_GENERIC =
  /^(?:soseaua|sos|strada|str|bulevardul|bdul|bd|calea|piata|pta|aleea|splaiul|intrarea|intr)\.?(?:\s+|$)/;

/** Stop-name key for the same-mode merge rule. Reuses the catalogue's
 * diacritic/case fold, strips one leading street generic, then collapses to
 * `[a-z0-9]`. `""` for a nameless stop (which then never satisfies same-mode). */
export function normalizeStopName(name: string | null | undefined): string {
  const folded = normalizeAmenityName(name ?? null);
  if (!folded) return "";
  const stripped = folded.replace(STREET_GENERIC, "");
  return (stripped || folded).replace(/[^a-z0-9]/g, "");
}

const EARTH_M = 6_371_000;
const rad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance in metres. */
export function haversineMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const dLat = rad(bLat - aLat);
  const dLng = rad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

function modesEqual(a: readonly string[] = [], b: readonly string[] = []): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((mode, i) => mode === sb[i]);
}

/**
 * Fuse coincident transit stops. Non-transit items pass through untouched and
 * keep their order. Input is expected sorted by distance (the catalogue query's
 * ORDER BY), so the nearest member of a cluster is the representative marker.
 *
 * Returns the rewritten list plus `absorbedTransit` = Σ(members−1) over merged
 * groups, for the caller's count adjustment.
 */
export function mergeCoincidentTransitStops<T extends Amenity>(
  items: readonly T[],
): { amenities: T[]; absorbedTransit: number } {
  const transitIdx: number[] = [];
  for (let i = 0; i < items.length; i++) if (items[i].category === "transit") transitIdx.push(i);
  if (transitIdx.length < 2) return { amenities: [...items], absorbedTransit: 0 };

  const nameKeyCache = new Map<number, string>();
  const nameKey = (i: number): string => {
    let k = nameKeyCache.get(i);
    if (k === undefined) {
      k = normalizeStopName(items[i].name);
      nameKeyCache.set(i, k);
    }
    return k;
  };

  // Candidate edges between transit stops passing the conservative predicate.
  const edges: { i: number; j: number; d: number }[] = [];
  for (let x = 0; x < transitIdx.length; x++) {
    for (let y = x + 1; y < transitIdx.length; y++) {
      const i = transitIdx[x];
      const j = transitIdx[y];
      const a = items[i];
      const b = items[j];
      const d = haversineMeters(a.lat, a.lng, b.lat, b.lng);
      const aModes = a.modes ?? [];
      const bModes = b.modes ?? [];
      // Cross-mode (merge without a name check) requires BOTH stops to have a
      // known, differing mode set. An unknown (empty) mode set fails safe to the
      // same-mode rule, so it can never trigger a name-free merge. (F3 latent.)
      const crossMode = aModes.length > 0 && bModes.length > 0 && !modesEqual(aModes, bModes);
      const merge = crossMode
        ? d <= R_CROSS_M
        : d <= R_SAME_M && nameKey(i) !== "" && nameKey(i) === nameKey(j);
      if (merge) edges.push({ i, j, d });
    }
  }
  edges.sort((p, q) => p.d - q.d);

  // Kruskal union-find with a diameter cap: shortest edges union first, and an
  // edge that would stretch a component past MAX_SPAN is DROPPED (not the whole
  // component dissolved), so a good tight pair survives a far dangling third node.
  const parent = new Map<number, number>();
  const membersOf = new Map<number, number[]>();
  for (const i of transitIdx) {
    parent.set(i, i);
    membersOf.set(i, [i]);
  }
  const find = (i: number): number => {
    let root = i;
    while (parent.get(root)! !== root) root = parent.get(root)!;
    let cur = i;
    while (parent.get(cur)! !== cur) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  // Both sub-components are already within MAX_SPAN internally (invariant from
  // prior unions), so only the cross pairs can breach the cap.
  const withinSpan = (ma: number[], mb: number[]): boolean => {
    for (const i of ma) {
      for (const j of mb) {
        if (haversineMeters(items[i].lat, items[i].lng, items[j].lat, items[j].lng) > MAX_SPAN_M) {
          return false;
        }
      }
    }
    return true;
  };
  for (const edge of edges) {
    const ra = find(edge.i);
    const rb = find(edge.j);
    if (ra === rb) continue;
    const ma = membersOf.get(ra)!;
    const mb = membersOf.get(rb)!;
    if (!withinSpan(ma, mb)) continue;
    parent.set(rb, ra);
    membersOf.set(ra, ma.concat(mb));
    membersOf.delete(rb);
  }

  // Emit in original order. The first (nearest) member of a multi-stop group is
  // its representative marker; later members are skipped.
  let absorbedTransit = 0;
  const emitted = new Set<number>();
  const out: T[] = [];
  for (let i = 0; i < items.length; i++) {
    if (items[i].category !== "transit") {
      out.push(items[i]);
      continue;
    }
    const root = find(i);
    const group = membersOf.get(root)!;
    if (group.length === 1) {
      out.push(items[i]);
      continue;
    }
    if (emitted.has(root)) continue;
    emitted.add(root);
    const ordered = [...group].sort((p, q) => p - q);
    const members: TransitStopMember[] = ordered.map((k) => ({
      osmType: items[k].osmType ?? "",
      osmId: items[k].osmId ?? 0,
      name: items[k].name,
      lat: items[k].lat,
      lng: items[k].lng,
    }));
    absorbedTransit += group.length - 1;
    out.push({ ...items[i], members, mergedCount: members.length });
  }

  return { amenities: out, absorbedTransit };
}
