-- OSM-derived data is isolated so licensing exports can never traverse into
-- public.Auth/Session/ApiCache tables.

-- CreateTable
CREATE TABLE "osm_catalogue"."AmenityImportRun" (
    "id" TEXT NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "source" VARCHAR(32) NOT NULL,
    "sourceTimestamp" TIMESTAMP(3),
    "sourceVersion" VARCHAR(100) NOT NULL,
    "sourceChecksum" VARCHAR(64) NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "failureMessage" TEXT,
    "rawElementCount" INTEGER,
    "acceptedPlaceCount" INTEGER,
    "rejectedElementCount" INTEGER,
    "validation" JSONB,

    CONSTRAINT "AmenityImportRun_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AmenityImportRun_status_check" CHECK ("status" IN ('running', 'validated', 'published', 'failed')),
    CONSTRAINT "AmenityImportRun_counts_check" CHECK (
      COALESCE("rawElementCount", 0) >= 0 AND
      COALESCE("acceptedPlaceCount", 0) >= 0 AND
      COALESCE("rejectedElementCount", 0) >= 0
    )
);

-- CreateTable
CREATE TABLE "osm_catalogue"."AmenityDataset" (
    "id" TEXT NOT NULL,
    "importRunId" TEXT NOT NULL,
    "sourceTimestamp" TIMESTAMP(3),
    "sourceVersion" VARCHAR(100) NOT NULL,
    "sourceChecksum" VARCHAR(64) NOT NULL,
    "placeCount" INTEGER NOT NULL,
    "validationPassed" BOOLEAN NOT NULL,
    "validation" JSONB NOT NULL,
    "activeKey" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),

    CONSTRAINT "AmenityDataset_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AmenityDataset_activeKey_check" CHECK ("activeKey" IS NULL OR "activeKey" = 1),
    CONSTRAINT "AmenityDataset_placeCount_check" CHECK ("placeCount" >= 0)
);

-- CreateTable
CREATE TABLE "osm_catalogue"."AmenityPlace" (
    "id" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "sourceType" VARCHAR(16) NOT NULL,
    "sourceId" BIGINT NOT NULL,
    "canonicalId" VARCHAR(100) NOT NULL,
    "category" VARCHAR(32) NOT NULL,
    "name" TEXT,
    "normalizedName" TEXT,
    "accessState" VARCHAR(20) NOT NULL,
    "qualityState" VARCHAR(20) NOT NULL,
    "sourceTags" JSONB NOT NULL,
    "representativePoint" geometry(Point,4326) NOT NULL,
    "geom" geometry(Geometry,4326) NOT NULL,
    "sourceUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AmenityPlace_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AmenityPlace_sourceType_check" CHECK ("sourceType" IN ('node', 'way', 'relation')),
    CONSTRAINT "AmenityPlace_category_check" CHECK (length("category") > 0),
    CONSTRAINT "AmenityPlace_geometry_check" CHECK (
      NOT ST_IsEmpty("representativePoint") AND NOT ST_IsEmpty("geom")
    )
);

-- CreateIndex
CREATE INDEX "AmenityImportRun_status_startedAt_idx" ON "osm_catalogue"."AmenityImportRun"("status", "startedAt");
CREATE INDEX "AmenityImportRun_sourceChecksum_idx" ON "osm_catalogue"."AmenityImportRun"("sourceChecksum");
CREATE UNIQUE INDEX "AmenityDataset_importRunId_key" ON "osm_catalogue"."AmenityDataset"("importRunId");
CREATE UNIQUE INDEX "AmenityDataset_activeKey_key" ON "osm_catalogue"."AmenityDataset"("activeKey");
CREATE INDEX "AmenityDataset_publishedAt_idx" ON "osm_catalogue"."AmenityDataset"("publishedAt");
CREATE INDEX "AmenityPlace_datasetId_category_idx" ON "osm_catalogue"."AmenityPlace"("datasetId", "category");
CREATE INDEX "AmenityPlace_datasetId_normalizedName_idx" ON "osm_catalogue"."AmenityPlace"("datasetId", "normalizedName");
CREATE INDEX "AmenityPlace_representativePoint_gist" ON "osm_catalogue"."AmenityPlace" USING GIST ("representativePoint");
CREATE INDEX "AmenityPlace_geom_gist" ON "osm_catalogue"."AmenityPlace" USING GIST ("geom");
CREATE UNIQUE INDEX "AmenityPlace_datasetId_sourceType_sourceId_key" ON "osm_catalogue"."AmenityPlace"("datasetId", "sourceType", "sourceId");
CREATE UNIQUE INDEX "AmenityPlace_datasetId_canonicalId_key" ON "osm_catalogue"."AmenityPlace"("datasetId", "canonicalId");

-- AddForeignKey
ALTER TABLE "osm_catalogue"."AmenityDataset" ADD CONSTRAINT "AmenityDataset_importRunId_fkey" FOREIGN KEY ("importRunId") REFERENCES "osm_catalogue"."AmenityImportRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "osm_catalogue"."AmenityPlace" ADD CONSTRAINT "AmenityPlace_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "osm_catalogue"."AmenityDataset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
