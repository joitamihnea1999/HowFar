import { NextResponse } from "next/server";

import { probeDb } from "@/lib/health";

// Liveness: always 200 while the process serves requests; reports subsystem flags.
export const dynamic = "force-dynamic";

export async function GET() {
  const dbUp = await probeDb();
  return NextResponse.json({ ok: true, db: dbUp });
}
