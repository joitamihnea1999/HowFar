import { readFile } from "node:fs/promises";

import overridesJson from "./amenities/overrides.json";

import {
  BULK_OVERPASS_MAX_BYTES,
  type BulkOverpassBody,
  type BulkOverpassSnapshot,
} from "../src/features/amenities/server/bulk-overpass";
import {
  refreshAmenityCatalogue,
  type CatalogueImportResult,
} from "../src/features/amenities/server/catalogue-import";
import type { CatalogueOverrides } from "../src/features/amenities/server/catalogue-normalize";
import { db } from "../src/lib/db";

function audit(result: CatalogueImportResult) {
  return {
    event: result.unchanged ? "amenity_catalogue_unchanged" : "amenity_catalogue_published",
    runId: result.runId,
    datasetId: result.datasetId,
    sourceVersion: result.sourceVersion,
    sourceTimestamp: result.sourceTimestamp,
    checksum: result.checksum,
    rawElementCount: result.rawElementCount,
    placeCount: result.placeCount,
    validation: result.validation,
  };
}

async function notifyFailure(detail: string): Promise<void> {
  const url = process.env.AMENITY_IMPORT_ALERT_WEBHOOK_URL?.trim();
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "amenity_catalogue_failed", detail }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error) {
    console.error(JSON.stringify({
      event: "amenity_catalogue_alert_failed",
      detail: error instanceof Error ? error.message : String(error),
    }));
  }
}

async function snapshotFileFetcher(): Promise<(() => Promise<BulkOverpassSnapshot>) | undefined> {
  const flagIndex = process.argv.indexOf("--snapshot");
  if (flagIndex === -1) return undefined;
  const filePath = process.argv[flagIndex + 1];
  if (!filePath) throw new Error("--snapshot requires a file path");

  const bytes = await readFile(filePath);
  if (bytes.byteLength > BULK_OVERPASS_MAX_BYTES) {
    throw new Error(`snapshot exceeds ${BULK_OVERPASS_MAX_BYTES} bytes`);
  }
  const body = JSON.parse(bytes.toString("utf8")) as BulkOverpassBody;
  return async () => ({ body, bytes, endpoint: "file://local-snapshot" });
}

async function main(): Promise<void> {
  try {
    const fetchSnapshot = await snapshotFileFetcher();
    const result = await refreshAmenityCatalogue(
      overridesJson as CatalogueOverrides,
      fetchSnapshot,
    );
    console.log(JSON.stringify(audit(result)));
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    console.error(JSON.stringify({ event: "amenity_catalogue_failed", detail }));
    await notifyFailure(detail);
    process.exitCode = 1;
  } finally {
    await db().$disconnect();
  }
}

void main();
