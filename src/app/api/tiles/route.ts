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

async function statArchive() {
  try {
    return await fs.stat(TILES_PATH);
  } catch {
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
  const handle = await fs.open(TILES_PATH, "r");
  try {
    const buffer = Buffer.alloc(length);
    // fs promises reads may return short on some platforms — fill the slice.
    let filled = 0;
    while (filled < length) {
      const { bytesRead } = await handle.read(buffer, filled, length - filled, range.start + filled);
      if (bytesRead === 0) return new Response(null, { status: 500 }); // file shrank mid-read
      filled += bytesRead;
    }
    return new Response(new Uint8Array(buffer), {
      status: 206,
      headers: {
        ...baseHeaders(stat),
        "Content-Range": `bytes ${range.start}-${range.end}/${stat.size}`,
        "Content-Length": String(length),
      },
    });
  } finally {
    await handle.close();
  }
}
