import {
  bboxesEqual,
  coerceBbox,
  DEFAULT_BBOX,
  LAUNCH_BBOX,
  type Bbox,
} from "@/lib/bounds";
import { db } from "@/lib/db";

/**
 * Region cross-check for the active amenity catalogue (task 013).
 *
 * The amenity dataset records the bbox it was imported under in its `validation`
 * JSON (`source.bbox`, written by `catalogue-import.ts` — see `CatalogueValidation`).
 * Once the map extent is config-driven (`NEXT_PUBLIC_MAP_BBOX`, task 007), flipping
 * to another city while the OLD city's dataset is still active would serve
 * new-city rings ∩ old-city places = an honest-looking empty 200 with no operator
 * signal. This module is the SINGLE place that decides "does the active dataset's
 * region match the configured extent?", so every serving surface (amenities,
 * catalogue-status, /api/ready, catalogue-export) and the importer's delta baseline
 * agree by construction.
 *
 * Deliberately light — imports only `bounds` + `db` — so the `/api/ready` route
 * does not pull the whole importer graph into its bundle.
 */

/**
 * Tri-state read of the import bbox out of a dataset's `validation` JSON (Prisma
 * `Json` column, so `unknown` here). Mirrors the `validation*` reader pattern in
 * `catalogue-import.ts` and pins to the write site `CatalogueValidation.source.bbox`
 * (search `bbox: LAUNCH_BBOX` there).
 *
 * The THREE states matter for fail-closed correctness: a legacy dataset that
 * predates the task-007 bbox write has NO `source.bbox`
 * key at all (`"absent"`) and may be grandfathered under the default extent; a
 * present-but-unparseable box (writer/reader drift, corruption, wrong types —
 * `"malformed"`) must NOT be trusted — collapsing it into the same `null` as
 * `"absent"` would silently disable the guard under the default extent.
 */
export type BboxReadout = "absent" | "malformed" | Bbox;

/** A plain JSON object (not null, not an array). Legacy datasets always wrote an
 *  object for `validation` and `validation.source`; anything else at those slots is
 *  corruption, never a legacy shape. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readValidationBbox(validation: unknown): BboxReadout {
  // "absent" is reserved for a genuinely EMPTY-but-well-formed legacy shape: a plain
  // object that simply predates the `source`/`source.bbox` write (or `undefined`,
  // i.e. the field was not selected). Anything PRESENT but structurally wrong at ANY
  // level — the `validation` root or `source` being null/array/string/number, or a
  // `bbox` that will not coerce — is "malformed" ⇒ fail closed regardless of extent,
  // never conflated with the legacy grandfather path. The root and `source` are
  // checked with the SAME rule so the fail-closed guarantee has no seam.
  if (validation === undefined) return "absent";
  if (!isPlainObject(validation)) return "malformed"; // JSONB null / array / primitive root
  if (!("source" in validation) || validation.source === undefined) return "absent";
  if (!isPlainObject(validation.source)) return "malformed";
  const raw = validation.source.bbox;
  if (raw === undefined) return "absent"; // legacy: `source` written, `bbox` field not
  const bbox = coerceBbox(raw);
  return bbox === null ? "malformed" : bbox;
}

/**
 * THE region semantic. True ⇒ the active dataset may be served; false ⇒ fail closed.
 *
 * - A dataset with a RECORDED, PARSEABLE bbox matches iff it equals the resolved
 *   extent (`LAUNCH_BBOX`). This catches the extent-flip hazard: after a flip, an old-city
 *   dataset's recorded box ≠ the new extent ⇒ fail closed.
 * - A `"malformed"` recorded bbox (present but unparseable) ⇒ **fail closed always**,
 *   regardless of extent — we cannot prove the region, so we refuse.
 * - A LEGACY `"absent"` bbox (imported before task 007 added the `source.bbox` write)
 *   is trusted ONLY when the resolved extent is still the default box: such a dataset
 *   was geofenced to the default city at import, so under the default extent serving
 *   it is correct and byte-identical to today (this keeps the existing prod
 *   deployment's healthcheck green). Under a FLIPPED extent it fails closed.
 */
export function datasetMatchesExtent(validation: unknown): boolean {
  const readout = readValidationBbox(validation);
  if (readout === "malformed") return false;
  if (readout === "absent") return bboxesEqual(LAUNCH_BBOX, DEFAULT_BBOX);
  return bboxesEqual(readout, LAUNCH_BBOX);
}

/**
 * Human-readable mismatch reason for server-side logs (never returned to a caller —
 * a bbox is not a secret, but the response bodies stay unchanged). Reports the
 * configured extent and what the dataset recorded (a box, nothing, or garbage).
 */
export function describeRegionMismatch(validation: unknown): string {
  const readout = readValidationBbox(validation);
  const configured = `[${LAUNCH_BBOX.minLng},${LAUNCH_BBOX.minLat},${LAUNCH_BBOX.maxLng},${LAUNCH_BBOX.maxLat}]`;
  const found =
    readout === "absent"
      ? "none (legacy dataset with no recorded bbox, under a non-default extent)"
      : readout === "malformed"
        ? "malformed (present but unparseable source.bbox)"
        : `[${readout.minLng},${readout.minLat},${readout.maxLng},${readout.maxLat}]`;
  return `active catalogue region ${found} does not match the configured extent ${configured}`;
}

/**
 * Active-dataset region status for `/api/ready` (which has no other active-dataset
 * read). `hasActive:false` ⇒ readiness is unaffected (a missing catalogue is
 * reported by `/api/catalogue-status`, not by readiness — unchanged behavior).
 * Returns the raw `validation` on a mismatch so the caller can log
 * `describeRegionMismatch` with the same configured-vs-recorded detail the other
 * surfaces emit.
 */
export async function activeDatasetRegionOk(): Promise<{
  hasActive: boolean;
  matches: boolean;
  validation?: unknown;
}> {
  const active = await db().amenityDataset.findUnique({
    where: { activeKey: 1 },
    select: { validation: true },
  });
  if (!active) return { hasActive: false, matches: true };
  const matches = datasetMatchesExtent(active.validation);
  return { hasActive: true, matches, validation: active.validation };
}
