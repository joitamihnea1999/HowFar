import { db } from "@/lib/db";
import { withTimeout } from "@/lib/timeout";

/** Bounded DB probe: a stalled connection must degrade the status, not hang the route. */
export const DB_PROBE_TIMEOUT_MS = 2000;

export async function probeDb(): Promise<boolean> {
  try {
    // db() itself throws EnvError when DATABASE_URL is absent — that also means "not ready".
    const result = await withTimeout(db().$queryRaw`SELECT 1`, DB_PROBE_TIMEOUT_MS);
    return result.ok;
  } catch {
    return false;
  }
}
