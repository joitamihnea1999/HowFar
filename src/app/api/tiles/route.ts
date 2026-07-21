import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

import { parseByteRange } from "@/lib/byte-range";

// Serves the self-hosted Protomaps archive with HTTP Range support (the
// pmtiles client reads the archive via byte-range requests). Keyless by
// design: the "external API keys stay server-side" constraint rules out
// browser-keyed tile providers.

const TILES_PATH = path.join(process.cwd(), "data", "tiles", "bucharest.pmtiles");

// pmtiles range requests are small (header ~16KB, tile batches well under 1MB);
// the cap keeps a hostile client from turning ranges into whole-archive buffers.
const MAX_RANGE_BYTES = 8 * 1024 * 1024;

export const dynamic = "force-dynamic";

/** Avoid fs.stat on every tile hop within a short window (map pan storms). */
const STAT_TTL_MS = 5_000;
let cachedStat: { size: number; mtimeMs: number; at: number } | null = null;

async function statArchive(): Promise<{ size: number; mtimeMs: number } | null> {
  const now = Date.now();
  if (cachedStat && now - cachedStat.at < STAT_TTL_MS) {
    return { size: cachedStat.size, mtimeMs: cachedStat.mtimeMs };
  }
  try {
    const stat = await fs.stat(TILES_PATH);
    cachedStat = { size: stat.size, mtimeMs: stat.mtimeMs, at: now };
    return { size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    cachedStat = null;
    return null;
  }
}

function baseHeaders(stat: { size: number; mtimeMs: number }): Record<string, string> {
  return {
    "Accept-Ranges": "bytes",
    "Content-Type": "application/octet-stream",
    "Cache-Control": "public, max-age=86400",
    ETag: `"${Math.round(stat.mtimeMs)}-${stat.size}"`,
  };
}

export async function HEAD() {
  const stat = await statArchive();
  if (!stat) return new Response(null, { status: 503 });
  return new Response(null, {
    headers: { ...baseHeaders(stat), "Content-Length": String(stat.size) },
  });
}

export async function GET(request: Request) {
  const stat = await statArchive();
  if (!stat) {
    return new Response("tile archive missing — run `npm run tiles:fetch`", { status: 503 });
  }

  const rangeHeader = request.headers.get("range");
  if (!rangeHeader) {
    // Whole-archive requests (curl, crawlers) are streamed, never buffered.
    const stream = Readable.toWeb(createReadStream(TILES_PATH)) as ReadableStream;
    return new Response(stream, {
      headers: { ...baseHeaders(stat), "Content-Length": String(stat.size) },
    });
  }

  const range = parseByteRange(rangeHeader, stat.size, MAX_RANGE_BYTES);
  if (!range) {
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${stat.size}` },
    });
  }

  const length = range.end - range.start + 1;
  // Stream the slice — do not allocate an 8MB buffer per range request.
  const nodeStream = createReadStream(TILES_PATH, {
    start: range.start,
    end: range.end,
  });
  const stream = Readable.toWeb(nodeStream) as ReadableStream;
  return new Response(stream, {
    status: 206,
    headers: {
      ...baseHeaders(stat),
      "Content-Range": `bytes ${range.start}-${range.end}/${stat.size}`,
      "Content-Length": String(length),
    },
  });
}
