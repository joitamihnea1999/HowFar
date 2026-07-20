import { NextResponse } from "next/server";

import { getCatalogueStatus } from "@/features/amenities/server/catalogue-status";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const status = await getCatalogueStatus();
    return NextResponse.json(status, { status: status.available && !status.stale ? 200 : 503 });
  } catch (error) {
    console.error("[api:catalogue-status] probe failed", error);
    return NextResponse.json(
      { available: false, stale: true, error: "Catalogue status unavailable" },
      { status: 503 },
    );
  }
}
