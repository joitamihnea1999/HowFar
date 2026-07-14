import { NextResponse } from "next/server";

import { probeDb } from "@/lib/health";

// Readiness: non-200 unless MySQL is reachable — Railway's healthcheck target,
// so a deploy with a broken DATABASE_URL is reported unhealthy, not silently up.
export const dynamic = "force-dynamic";

export async function GET() {
  const dbUp = await probeDb();
  return NextResponse.json({ ready: dbUp }, { status: dbUp ? 200 : 503 });
}
