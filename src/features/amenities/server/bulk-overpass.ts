import { AMENITY_CATEGORIES } from "@/features/amenities/amenities";
import type { OverpassElement } from "@/features/amenities/server/overpass-client";
import { BUCHAREST_BBOX } from "@/lib/bounds";
import { ProviderError, USER_AGENT } from "@/lib/provider-http";

const BULK_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
] as const;

export const BULK_OVERPASS_TIMEOUT_MS = 180_000;
export const BULK_OVERPASS_MAX_BYTES = 50 * 1024 * 1024;

export interface BulkOverpassBody {
  osm3s?: { timestamp_osm_base?: string; copyright?: string };
  elements?: OverpassElement[];
  remark?: string;
}

export interface BulkOverpassSnapshot {
  body: BulkOverpassBody;
  bytes: Uint8Array;
  endpoint: string;
}

export function buildBulkOverpassQuery(): string {
  const { minLat, minLng, maxLat, maxLng } = BUCHAREST_BBOX;
  const bbox = `${minLat},${minLng},${maxLat},${maxLng}`;
  const clauses = AMENITY_CATEGORIES.flatMap((category) =>
    category.predicates.map(
      (predicate) =>
        `nwr[${predicate.tag}~"^(${predicate.values.join("|")})$"](${bbox});`,
    ),
  ).join("");
  return `[out:json][timeout:120][maxsize:${256 * 1024 * 1024}];(${clauses});out geom;`;
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new ProviderError(`bulk Overpass response exceeds ${maxBytes} bytes`);
  }
  if (!response.body) throw new ProviderError("bulk Overpass response has no body");

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new ProviderError(`bulk Overpass response exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function fetchEndpoint(
  endpoint: string,
  query: string,
  timeoutMs: number,
  maxBytes: number,
): Promise<BulkOverpassSnapshot> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "User-Agent": USER_AGENT,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: `data=${encodeURIComponent(query)}`,
      signal: controller.signal,
    });
    if (!response.ok) throw new ProviderError(`bulk Overpass responded ${response.status}`);
    const bytes = await readBoundedBody(response, maxBytes);
    let body: BulkOverpassBody;
    try {
      body = JSON.parse(new TextDecoder().decode(bytes)) as BulkOverpassBody;
    } catch {
      throw new ProviderError("bulk Overpass returned invalid JSON");
    }
    if (!Array.isArray(body.elements) || body.elements.length === 0) {
      throw new ProviderError("bulk Overpass returned no elements");
    }
    if (body.remark && /timed out|timeout|quota|error|exceeded/i.test(body.remark)) {
      throw new ProviderError(`bulk Overpass remark: ${body.remark}`);
    }
    return { body, bytes, endpoint };
  } finally {
    clearTimeout(timer);
  }
}

/** One host at a time: the weekly bulk job never fans out across public mirrors. */
export async function fetchBulkOverpass(
  options: {
    endpoints?: readonly string[];
    timeoutMs?: number;
    maxBytes?: number;
  } = {},
): Promise<BulkOverpassSnapshot> {
  const endpoints = options.endpoints ?? BULK_ENDPOINTS;
  const query = buildBulkOverpassQuery();
  const failures: string[] = [];
  for (const endpoint of endpoints) {
    try {
      return await fetchEndpoint(
        endpoint,
        query,
        options.timeoutMs ?? BULK_OVERPASS_TIMEOUT_MS,
        options.maxBytes ?? BULK_OVERPASS_MAX_BYTES,
      );
    } catch (error) {
      failures.push(`${new URL(endpoint).host}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new ProviderError(`bulk Overpass unavailable (${failures.join("; ")})`);
}
