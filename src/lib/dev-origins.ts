/**
 * Parse `ALLOWED_DEV_ORIGINS` (a comma-separated env var) into the list Next's
 * top-level `allowedDevOrigins` config expects, for LAN device testing of the
 * dev server (task 018 — formalizes the owner's manual `next.config.ts` edit).
 *
 * Next compares ONLY the request HOSTNAME against these entries
 * (`next/dist/server/lib/router-utils/block-cross-site-dev.js` matches
 * `parsedOrigin.hostname.toLowerCase()`), so a scheme or `:port` on an entry
 * would never match. We therefore normalize each entry to a bare, lowercased
 * hostname — e.g. `http://192.168.1.42:3000` → `192.168.1.42` — while preserving
 * a wildcard entry like `*.local-origin.dev`.
 *
 * Returns `undefined` when unset/blank so `next.config.ts` is byte-identical to
 * having no `allowedDevOrigins` key at all (the default deployment is unchanged).
 */
export function parseAllowedDevOrigins(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const hostnames = raw
    .split(",")
    .map(hostnameOf)
    .filter((h) => h.length > 0);
  return hostnames.length > 0 ? hostnames : undefined;
}

/** Reduce one origin entry to the bare hostname Next actually matches on. */
function hostnameOf(entry: string): string {
  let s = entry.trim();
  if (!s) return "";
  s = s.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, ""); // strip a leading scheme://
  s = s.split("/", 1)[0]; // drop any path/query
  s = s.replace(/:\d+$/, ""); // drop a trailing :port
  return s.trim().toLowerCase();
}
