import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";

// Stable application-wide advisory-lock key. The lock is transaction-scoped,
// so a thrown error or lost connection always releases it automatically.
const PUBLICATION_LOCK_KEY = 2_026_072_001;

export const DEFAULT_RETAIN_INACTIVE_DATASETS = 2;

export class CataloguePublicationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CataloguePublicationError";
  }
}

export type PublishDatasetOptions = {
  publishedAt?: Date;
  retainInactiveDatasets?: number;
  /**
   * Optional last validation inside the publication transaction. Import code
   * can use this for checks which must remain true through commit. Throwing
   * rolls the active-pointer change and retention deletes back atomically.
   */
  verifyBeforeCommit?: (tx: Prisma.TransactionClient, datasetId: string) => Promise<void>;
};

/**
 * Atomically move the single active pointer to a validated immutable dataset.
 * The database UNIQUE(activeKey) constraint is the final invariant; the
 * advisory lock serializes publishers so two weekly jobs cannot race.
 */
export async function publishDataset(
  datasetId: string,
  options: PublishDatasetOptions = {},
): Promise<void> {
  const retainInactiveDatasets =
    options.retainInactiveDatasets ?? DEFAULT_RETAIN_INACTIVE_DATASETS;
  if (!Number.isSafeInteger(retainInactiveDatasets) || retainInactiveDatasets < 0) {
    throw new RangeError("retainInactiveDatasets must be a non-negative integer");
  }

  await db().$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT pg_advisory_xact_lock(${PUBLICATION_LOCK_KEY})::text AS lock
    `;

    const target = await tx.amenityDataset.findUnique({
      where: { id: datasetId },
      include: { importRun: true },
    });
    if (!target) throw new CataloguePublicationError(`Dataset ${datasetId} does not exist`);
    if (target.activeKey === 1) return;
    if (!target.validationPassed || target.importRun.status !== "validated") {
      throw new CataloguePublicationError(`Dataset ${datasetId} has not passed validation`);
    }

    const counts = await tx.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(*)::integer AS count
      FROM "osm_catalogue"."AmenityPlace"
      WHERE "datasetId" = ${datasetId}
    `;
    const actualPlaceCount = counts[0]?.count ?? 0;
    if (actualPlaceCount === 0 || actualPlaceCount !== target.placeCount) {
      throw new CataloguePublicationError(
        `Dataset ${datasetId} place count mismatch: expected ${target.placeCount}, found ${actualPlaceCount}`,
      );
    }

    const publishedAt = options.publishedAt ?? new Date();
    await tx.amenityDataset.updateMany({
      where: { activeKey: 1 },
      data: { activeKey: null },
    });
    await tx.amenityDataset.update({
      where: { id: datasetId },
      data: { activeKey: 1, publishedAt },
    });
    await tx.amenityImportRun.update({
      where: { id: target.importRunId },
      data: { status: "published", publishedAt, finishedAt: publishedAt },
    });

    await options.verifyBeforeCommit?.(tx, datasetId);

    // Crash-orphaned datasets — created but never published, so both activeKey
    // and publishedAt are null — are import debris, not backups. A weekly
    // refresh is single-writer (advisory import lock), so at publish time any
    // such row is genuinely abandoned. Delete them outright (cascade removes
    // their places) so they neither accumulate uncollected nor, sorting NULLS
    // FIRST under `publishedAt desc`, evict a real published backup.
    const orphans = await tx.amenityDataset.findMany({
      where: { activeKey: null, publishedAt: null },
      select: { id: true },
    });
    // Retain only the most recent *published* inactive datasets as rollbacks.
    const expired = await tx.amenityDataset.findMany({
      where: { activeKey: null, publishedAt: { not: null } },
      orderBy: [{ publishedAt: "desc" }, { createdAt: "desc" }],
      skip: retainInactiveDatasets,
      select: { id: true },
    });
    const removable = [...orphans, ...expired];
    if (removable.length > 0) {
      await tx.amenityDataset.deleteMany({
        where: { id: { in: removable.map(({ id }) => id) } },
      });
    }

    const activeCount = await tx.amenityDataset.count({ where: { activeKey: 1 } });
    if (activeCount !== 1) {
      throw new CataloguePublicationError(
        `Publication invariant failed: expected one active dataset, found ${activeCount}`,
      );
    }
  });
}

/**
 * Execute all reads for one response in a repeatable-read transaction and
 * pass the captured dataset ID explicitly. A concurrent publication therefore
 * cannot make counts and markers come from different snapshots.
 */
export async function withActiveDataset<T>(
  read: (tx: Prisma.TransactionClient, datasetId: string) => Promise<T>,
): Promise<T | null> {
  return db().$transaction(
    async (tx) => {
      const active = await tx.amenityDataset.findUnique({
        where: { activeKey: 1 },
        select: { id: true },
      });
      if (!active) return null;
      return read(tx, active.id);
    },
    { isolationLevel: "RepeatableRead" },
  );
}
