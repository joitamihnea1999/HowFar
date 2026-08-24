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
  let configOk = true;
  let configError: string | undefined;
  try {
    parseProviderConfig();
  } catch (err) {
    configOk = false;
    configError = err instanceof EnvError ? err.message : "invalid provider configuration";
  }

  const ready = dbUp && configOk;
  return NextResponse.json(
    { ready, db: dbUp, config: configOk, ...(configError ? { configError } : {}) },
    { status: ready ? 200 : 503 },
  );
}
