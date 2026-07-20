import { isCatalogueStale } from "@/features/amenities/server/catalogue";
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
      },
    }),
    db().amenityImportRun.findFirst({
      where: { status: "failed" },
      orderBy: { failedAt: "desc" },
      select: { failedAt: true, failureMessage: true },
    }),
  ]);

  return {
    available: active !== null,
    stale: !active || isCatalogueStale(active.sourceTimestamp, now),
    sourceTimestamp: active?.sourceTimestamp?.toISOString() ?? null,
    sourceVersion: active?.sourceVersion ?? null,
    sourceChecksum: active?.sourceChecksum ?? null,
    publishedAt: active?.publishedAt?.toISOString() ?? null,
    placeCount: active?.placeCount ?? 0,
    lastFailureAt: lastFailure?.failedAt?.toISOString() ?? null,
    lastFailureMessage: lastFailure?.failureMessage ?? null,
  };
}
