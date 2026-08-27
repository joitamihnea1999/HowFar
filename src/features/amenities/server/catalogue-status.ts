import { isCatalogueStale } from "@/features/amenities/server/catalogue";
import { datasetMatchesExtent, describeRegionMismatch } from "@/features/amenities/server/catalogue-region";
import { db } from "@/lib/db";

export interface CatalogueStatus {
  available: boolean;
  stale: boolean;
  sourceTimestamp: string | null;
  sourceVersion: string | null;
  sourceChecksum: string | null;
  publishedAt: string | null;
  placeCount: number;
  lastFailureAt: string | null;
  lastFailureMessage: string | null;
  /**
   * Set to "region-mismatch" ONLY when an active dataset exists but its recorded
   * region does not match the configured extent (task 013). It is the operator-visible
   * discriminator between "wrong city's catalogue is active" and "no catalogue at all"
   * — both otherwise report `available:false` with suppressed dataset fields. Carries
   * NO coordinates (the boxes stay in the server log), so it exposes the hazard without
   * leaking the foreign region. Absent (undefined) in every other case.
   */
  reason?: "region-mismatch";
}

export async function getCatalogueStatus(now = new Date()): Promise<CatalogueStatus> {
  const [active, lastFailure] = await Promise.all([
    db().amenityDataset.findUnique({
      where: { activeKey: 1 },
      select: {
        sourceTimestamp: true,
        sourceVersion: true,
        sourceChecksum: true,
        publishedAt: true,
        placeCount: true,
        validation: true,
      },
    }),
    db().amenityImportRun.findFirst({
      where: { status: "failed" },
      orderBy: { failedAt: "desc" },
      select: { failedAt: true, failureMessage: true },
    }),
  ]);

  // Region cross-check (task 013): an active dataset whose recorded import bbox
  // does not match the configured extent is NOT available — otherwise a post-flip
  // deployment would report `available:true` while serving the wrong city's places.
  const regionMatches = active !== null && datasetMatchesExtent(active.validation);
  if (active !== null && !regionMatches) {
    console.error(`[catalogue-status] ${describeRegionMismatch(active.validation)}`);
  }

  // When the active dataset is region-mismatched it is treated as unavailable, and
  // its dataset-derived fields are SUPPRESSED — this surface's whole purpose is to
  // never describe the wrong city's data, so it must not leak the foreign row's
  // placeCount/version/checksum/timestamps in the 503 body (only the server log
  // names them). Import-failure fields come from a different table and stay.
  return {
    available: regionMatches,
    stale: !regionMatches || isCatalogueStale(active?.sourceTimestamp ?? null, now),
    sourceTimestamp: regionMatches ? active?.sourceTimestamp?.toISOString() ?? null : null,
    sourceVersion: regionMatches ? active?.sourceVersion ?? null : null,
    sourceChecksum: regionMatches ? active?.sourceChecksum ?? null : null,
    publishedAt: regionMatches ? active?.publishedAt?.toISOString() ?? null : null,
    placeCount: regionMatches ? active?.placeCount ?? 0 : 0,
    lastFailureAt: lastFailure?.failedAt?.toISOString() ?? null,
    lastFailureMessage: lastFailure?.failureMessage ?? null,
    // Operator-visible discriminator: only a PRESENT-but-wrong-region active dataset.
    ...(active !== null && !regionMatches ? { reason: "region-mismatch" as const } : {}),
  };
}
