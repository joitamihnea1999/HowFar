import { modeLabel, type StopLine } from "@/features/amenities/stop-lines";

/**
 * Pure presentation model for the transit-stop popup (task 021). The AppMap
 * click handler is imperative MapLibre/DOM glue (coverage-excluded, e2e-tested),
 * so ALL the state/label decisions live here where they're unit-measured: the
 * fetch phase → which of loading/error/empty/ready to show, and the per-line
 * row labels. The DOM renderer just walks `rows` and sets `textContent`.
 */

export interface StopPopupRow {
  /** Human mode label, e.g. "Bus", "Metro". */
  modeLabel: string;
  /** Line number/name, e.g. "331B", "M2". */
  ref: string;
  /** Destination headsign; omitted when unknown (never invented). */
  direction?: string;
  /** OSM route relation id — present ⇒ the row is selectable and can draw its
   * path (task 024); absent ⇒ plain informational row. */
  relationId?: number;
}

export type StopPopupModel =
  | { kind: "loading"; title: string }
  | { kind: "error"; title: string }
  | { kind: "empty"; title: string }
  | { kind: "ready"; title: string; rows: StopPopupRow[] };

/** Copy shared by the DOM renderer and the e2e assertions. */
export const STOP_POPUP_TEXT = {
  loading: "Finding lines…",
  error: "Line info unavailable right now",
  empty: "No line data mapped for this stop",
} as const;

const FALLBACK_TITLE = "Transit stop";

/**
 * Map a fetch phase (+ lines, when ready) to the popup model. `ready` with no
 * lines collapses to `empty` (the honest "no line data" state, not a broken
 * popup). A blank title falls back to a generic label.
 */
export function buildStopPopupModel(
  title: string,
  phase: "loading" | "error" | "ready",
  lines?: readonly StopLine[],
): StopPopupModel {
  const t = title.trim() || FALLBACK_TITLE;
  if (phase === "loading") return { kind: "loading", title: t };
  if (phase === "error") return { kind: "error", title: t };
  const rows: StopPopupRow[] = (lines ?? []).map((l) => {
    const row: StopPopupRow = { modeLabel: modeLabel(l.mode), ref: l.ref };
    if (l.direction) row.direction = l.direction;
    if (typeof l.relationId === "number") row.relationId = l.relationId;
    return row;
  });
  return rows.length ? { kind: "ready", title: t, rows } : { kind: "empty", title: t };
}
