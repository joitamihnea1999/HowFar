import { db } from "@/lib/db";
import { withTimeout } from "@/lib/timeout";

/** Bounded DB probe: a stalled connection must degrade the status, not hang the route. */
export const DB_PROBE_TIMEOUT_MS = 2000;

export async function probeDb(timeoutMs: number = DB_PROBE_TIMEOUT_MS): Promise<boolean> {
  try {
    // db() itself throws EnvError when DATABASE_URL is absent — that also means "not ready".
    const result = await withTimeout(
      db().$queryRaw<Array<{ postgis: boolean; migrations: boolean }>>`
        SELECT
          EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'postgis') AS postgis,
          to_regclass('public._prisma_migrations') IS NOT NULL AS migrations
      `,
      timeoutMs,
    );
    if (!result.ok) {
      // Surface WHY readiness fails (connection refused, auth, TLS, timeout…) — a
      // silently-swallowed reason makes prod DB outages undiagnosable.
      console.error(
        `[probeDb] database not ready (${result.reason})`,
        result.reason === "error" ? result.error : "",
      );
    }
    if (!result.ok) return false;
    const ready = result.value[0]?.postgis === true && result.value[0]?.migrations === true;
    if (!ready) console.error("[probeDb] database missing PostGIS or migration history");
    return ready;
  } catch (err) {
    console.error("[probeDb] database probe threw:", err);
    return false;
  }
}
