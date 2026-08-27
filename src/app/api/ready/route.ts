import { NextResponse } from "next/server";

import { activeDatasetRegionOk, describeRegionMismatch } from "@/features/amenities/server/catalogue-region";
import { EnvError, parseProviderConfig } from "@/lib/env";
import { DB_PROBE_TIMEOUT_MS, probeDb } from "@/lib/health";
import { withTimeout } from "@/lib/timeout";

// Readiness: non-200 unless PostgreSQL is reachable (probeDb also proves PostGIS +
// the migration history), the provider/region configuration parses, AND the active
// amenity catalogue's recorded region matches the configured extent — Railway's
// healthcheck target, so a deploy with a broken DATABASE_URL, a malformed provider
// env var (task 007), or a catalogue belonging to a different city than the
// configured extent (task 013) is reported unhealthy rather than passing the
// healthcheck and then serving the wrong city's data / 5xx-ing the first request.
export const dynamic = "force-dynamic";

export async function GET() {
  const dbUp = await probeDb();

  // parseProviderConfig throws EnvError on a SET-but-invalid provider var
  // (bad URL/scheme, empty pool, a non-integer/out-of-range rate interval, or a
  // sub-fair-use interval left on a public provider host — task 009). The extent
  // is validated separately at build (bounds.ts import). Absent vars use the
  // public defaults and never throw. (Not covered here: the conditional ORS key
  // — a public-host base with ORS_API_KEY unset still passes readiness and only
  // fails at request time; hardening that is a tracked deploy follow-up.)
  // Failures are logged server-side only — the (possibly value-bearing) message
  // must not reach an unauthenticated caller, so the response body is unchanged.
  let configOk = true;
  try {
    parseProviderConfig();
  } catch (err) {
    configOk = false;
    const msg = err instanceof EnvError ? err.message : "invalid provider configuration";
    console.error(`[api:ready] provider configuration invalid: ${msg}`);
  }

  // Active-catalogue region check (task 013). Only probed when the DB is already up
  // (no point, and no second failure mode, when probeDb has failed). A definitive
  // MISMATCH fails readiness; a query ERROR also fails readiness (fail closed — we
  // cannot confirm the region), never silently passing. A missing catalogue does
  // NOT fail readiness (unchanged: catalogue presence is /api/catalogue-status's
  // concern). The reason is logged server-side only.
  let regionOk = true;
  if (dbUp) {
    // Bounded like probeDb (2s): a locked/slow AmenityDataset read must DEGRADE the
    // status, not hang the Railway readiness probe. A timeout or query error ⇒ not
    // ready (fail closed — an unverifiable region must not pass).
    const probe = await withTimeout(activeDatasetRegionOk(), DB_PROBE_TIMEOUT_MS);
    if (!probe.ok) {
      regionOk = false;
      console.error(
        `[api:ready] active-catalogue region check failed (${probe.reason})`,
        probe.reason === "error" ? probe.error : "",
      );
    } else if (!probe.value.matches) {
      regionOk = false;
      console.error(`[api:ready] ${describeRegionMismatch(probe.value.validation)}`);
    }
  }

  const ready = dbUp && configOk && regionOk;
  return NextResponse.json({ ready }, { status: ready ? 200 : 503 });
}
