import { promises as fs } from "node:fs";
import path from "node:path";

// Serves the self-hosted Protomaps archive with HTTP Range support (the
// pmtiles client reads the archive via byte-range requests). Keyless by
// design: the "external API keys stay server-side" constraint rules out
// browser-keyed tile providers.

const TILES_PATH = path.join(process.cwd(), "data", "tiles", "bucharest.pmtiles");

export const dynamic = "force-dynamic";

interface ByteRange {
  start: number;
  end: number;
}

function parseRange(header: string, size: number): ByteRange | null {
  const explicit = /^bytes=(\d+)-(\d*)$/.exec(header);
  if (explicit) {
    const start = Number(explicit[1]);
    const end = explicit[2] ? Math.min(Number(explicit[2]), size - 1) : size - 1;
    if (start >= size || start > end) return null;
    return { start, end };
  }
  const suffix = /^bytes=-(\d+)$/.exec(header);
  if (suffix) {
    const length = Math.min(Number(suffix[1]), size);
    if (length === 0) return null;
    return { start: size - length, end: size - 1 };
  }
  return null;
}

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
    const whole = await fs.readFile(TILES_PATH);
    return new Response(new Uint8Array(whole), {
      headers: { ...baseHeaders(stat), "Content-Length": String(stat.size) },
    });
  }

  const range = parseRange(rangeHeader, stat.size);
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
    await handle.read(buffer, 0, length, range.start);
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
