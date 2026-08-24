import { NextResponse } from "next/server";

import { EnvError, parseProviderConfig } from "@/lib/env";
import { probeDb } from "@/lib/health";

// Readiness: non-200 unless PostgreSQL is reachable AND the provider/region
// configuration parses — Railway's healthcheck target, so a deploy with a broken
// DATABASE_URL or a malformed provider env var (task 007) is reported unhealthy
// rather than passing the healthcheck and 5xx-ing the first user request.
export const dynamic = "force-dynamic";

export async function GET() {
  const dbUp = await probeDb();

  // parseProviderConfig throws EnvError on a SET-but-invalid provider var
  // (bad URL/scheme, empty pool). The extent is validated separately at build
  // (bounds.ts import). Absent vars use the public defaults and never throw.
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

  const ready = dbUp && configOk;
  return NextResponse.json({ ready }, { status: ready ? 200 : 503 });
}
