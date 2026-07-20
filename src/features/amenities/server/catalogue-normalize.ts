import {
  categoryForTags,
  type AmenityCategoryKey,
} from "@/features/amenities/amenities";
import type { OverpassElement } from "@/features/amenities/server/overpass-client";
import { inBucharest } from "@/lib/bounds";

export type CatalogueDropReason =
  | "unclassified"
  | "invalid_identity"
  | "invalid_geometry"
  | "outside_bounds"
  | "lifecycle"
  | "private_park"
  | "unnamed_garden"
  | "manual_suppression";

export type CatalogueOverrides = {
  version: 1;
  suppress: string[];
};

export type CatalogueGeometry =
  | GeoJSON.Point
  | GeoJSON.LineString
  | GeoJSON.Polygon
  | GeoJSON.MultiLineString;

export interface NormalizedCataloguePlace {
  sourceType: "node" | "way" | "relation";
  sourceId: number;
  canonicalId: string;
  category: AmenityCategoryKey;
  name: string | null;
  normalizedName: string | null;
  accessState: "public" | "private" | "unknown";
  qualityState: "included";
  sourceTags: Record<string, string>;
  sourceUpdatedAt: Date | null;
  geometry: CatalogueGeometry;
  buildArea: boolean;
}

export type NormalizeElementResult =
  | { place: NormalizedCataloguePlace; dropReason?: never }
  | { place?: never; dropReason: CatalogueDropReason };

const LIFECYCLE_VALUES = new Set(["yes", "true", "1"]);
const PRIVATE_ACCESS = new Set(["private", "no", "customers", "permit"]);
const PUBLIC_ACCESS = new Set(["yes", "public", "permissive", "destination"]);

export function cleanAmenityName(value: string | undefined): string | null {
  if (!value) return null;
  const cleaned = value.normalize("NFKC").replace(/\s+/g, " ").trim();
  return cleaned || null;
}

export function normalizeAmenityName(value: string | null): string | null {
  if (!value) return null;
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("ro-RO")
    .replace(/\s+/g, " ")
    .trim();
}

function lifecycleInactive(tags: Record<string, string>): boolean {
  if (["disused", "abandoned", "demolished", "removed"].some((key) => LIFECYCLE_VALUES.has(tags[key]))) {
    return true;
  }
  if (tags.construction && tags.construction !== "no") return true;
  return Object.keys(tags).some((key) =>
    /^(disused|abandoned|demolished|removed|construction):/.test(key),
  );
}

function accessState(tags: Record<string, string>): "public" | "private" | "unknown" {
  const access = tags.access?.toLowerCase();
  if (access && PRIVATE_ACCESS.has(access)) return "private";
  if (access && PUBLIC_ACCESS.has(access)) return "public";
  return "unknown";
}

function point(lat: unknown, lon: unknown): GeoJSON.Point | null {
  const parsedLat = Number(lat);
  const parsedLon = Number(lon);
  if (!Number.isFinite(parsedLat) || !Number.isFinite(parsedLon)) return null;
  if (parsedLat < -90 || parsedLat > 90 || parsedLon < -180 || parsedLon > 180) return null;
  return { type: "Point", coordinates: [parsedLon, parsedLat] };
}

function lineCoordinates(
  geometry: { lat?: number; lon?: number }[] | undefined,
): GeoJSON.Position[] | null {
  if (!Array.isArray(geometry)) return null;
  const coordinates: GeoJSON.Position[] = [];
  for (const coordinate of geometry) {
    const parsed = point(coordinate.lat, coordinate.lon);
    if (!parsed) return null;
    coordinates.push(parsed.coordinates);
  }
  return coordinates.length >= 2 ? coordinates : null;
}

function samePosition(a: GeoJSON.Position, b: GeoJSON.Position): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

function elementGeometry(element: OverpassElement): CatalogueGeometry | null {
  if (element.type === "node") return point(element.lat, element.lon);
  if (element.type === "way") {
    const coordinates = lineCoordinates(element.geometry);
    if (!coordinates) return null;
    if (coordinates.length >= 4 && samePosition(coordinates[0]!, coordinates.at(-1)!)) {
      return { type: "Polygon", coordinates: [coordinates] };
    }
    return { type: "LineString", coordinates };
  }
  if (element.type === "relation") {
    const lines = (element.members ?? [])
      .map((member) => lineCoordinates(member.geometry))
      .filter((coordinates): coordinates is GeoJSON.Position[] => coordinates !== null);
    return lines.length > 0 ? { type: "MultiLineString", coordinates: lines } : null;
  }
  return null;
}

function hasCoordinateInBounds(geometry: CatalogueGeometry): boolean {
  const positions: GeoJSON.Position[] =
    geometry.type === "Point"
      ? [geometry.coordinates]
      : geometry.type === "LineString"
        ? geometry.coordinates
        : geometry.type === "Polygon"
          ? geometry.coordinates.flat()
          : geometry.coordinates.flat();
  return positions.some(([lng, lat]) => inBucharest(Number(lat), Number(lng)));
}

export function normalizeCatalogueElement(
  element: OverpassElement,
  suppressedSourceIds: ReadonlySet<string> = new Set(),
): NormalizeElementResult {
  const category = categoryForTags(element.tags);
  if (!category) return { dropReason: "unclassified" };
  if (
    (element.type !== "node" && element.type !== "way" && element.type !== "relation") ||
    !Number.isSafeInteger(element.id) ||
    Number(element.id) <= 0
  ) {
    return { dropReason: "invalid_identity" };
  }

  const sourceType = element.type;
  const sourceId = Number(element.id);
  const canonicalId = `${sourceType}/${sourceId}`;
  if (suppressedSourceIds.has(canonicalId)) return { dropReason: "manual_suppression" };

  const tags = element.tags ?? {};
  if (lifecycleInactive(tags)) return { dropReason: "lifecycle" };
  const access = accessState(tags);
  if (category === "parks" && access === "private") return { dropReason: "private_park" };

  const name = cleanAmenityName(tags.name ?? tags["name:ro"]);
  if (category === "parks" && tags.leisure === "garden" && !name) {
    return { dropReason: "unnamed_garden" };
  }

  const geometry = elementGeometry(element);
  if (!geometry) return { dropReason: "invalid_geometry" };
  if (!hasCoordinateInBounds(geometry)) return { dropReason: "outside_bounds" };

  const parsedTimestamp = element.timestamp ? new Date(element.timestamp) : null;
  return {
    place: {
      sourceType,
      sourceId,
      canonicalId,
      category,
      name,
      normalizedName: normalizeAmenityName(name),
      accessState: access,
      qualityState: "included",
      sourceTags: tags,
      sourceUpdatedAt:
        parsedTimestamp && Number.isFinite(parsedTimestamp.getTime()) ? parsedTimestamp : null,
      geometry,
      buildArea: sourceType === "relation",
    },
  };
}
