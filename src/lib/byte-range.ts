/** Inclusive byte range within a resource of known size. */
export interface ByteRange {
  start: number;
  end: number;
}

/**
 * Parse a single-range `Range` header (`bytes=a-b`, `bytes=a-`, `bytes=-n`)
 * against a resource of `size` bytes, capping the returned slice at
 * `maxLength` bytes. Returns null for malformed, unsatisfiable, or
 * over-cap requests (callers answer 416) — never a range outside [0, size).
 */
export function parseByteRange(header: string, size: number, maxLength: number): ByteRange | null {
  if (size <= 0) return null;

  let range: ByteRange | null = null;

  const explicit = /^bytes=(\d+)-(\d*)$/.exec(header);
  if (explicit) {
    const start = Number(explicit[1]);
    const end = explicit[2] ? Math.min(Number(explicit[2]), size - 1) : size - 1;
    range = start >= size || start > end || !Number.isSafeInteger(start) ? null : { start, end };
  } else {
    const suffix = /^bytes=-(\d+)$/.exec(header);
    if (suffix) {
      const length = Math.min(Number(suffix[1]), size);
      range = length === 0 || !Number.isSafeInteger(length) ? null : { start: size - length, end: size - 1 };
    }
  }

  if (!range) return null;
  if (range.end - range.start + 1 > maxLength) return null;
  return range;
}
