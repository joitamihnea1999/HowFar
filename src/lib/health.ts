import { db } from "@/lib/db";
import { withTimeout } from "@/lib/timeout";

/** Bounded DB probe: a stalled connection must degrade the status, not hang the route. */
export const DB_PROBE_TIMEOUT_MS = 2000;

export async function probeDb(timeoutMs: number = DB_PROBE_TIMEOUT_MS): Promise<boolean> {
  try {
    // db() itself throws EnvError when DATABASE_URL is absent — that also means "not ready".
    const result = await withTimeout(db().$queryRaw`SELECT 1`, timeoutMs);
    if (!result.ok) {
      // Surface WHY readiness fails (connection refused, auth, TLS, timeout…) — a
      // silently-swallowed reason makes prod DB outages undiagnosable.
      console.error(
        `[probeDb] database not ready (${result.reason})`,
        result.reason === "error" ? result.error : "",
      );
    }
    return result.ok;
  } catch (err) {
    console.error("[probeDb] database probe threw:", err);
    return false;
  }
}
