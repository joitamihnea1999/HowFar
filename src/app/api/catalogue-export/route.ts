import { NextResponse } from "next/server";

import {
  CATALOGUE_EXPORT_MAX_PAGE_SIZE,
  exportCataloguePage,
} from "@/features/amenities/server/catalogue-export";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const after = url.searchParams.get("after");
  const rawLimit = url.searchParams.get("limit") ?? "500";
  const limit = Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > CATALOGUE_EXPORT_MAX_PAGE_SIZE) {
    return NextResponse.json(
      { error: `limit must be an integer from 1 to ${CATALOGUE_EXPORT_MAX_PAGE_SIZE}` },
      { status: 400 },
    );
  }
  if (after !== null && (after.length === 0 || after.length > 200)) {
    return NextResponse.json({ error: "invalid after cursor" }, { status: 400 });
  }

  try {
    const page = await exportCataloguePage(after, limit);
    if (!page) return NextResponse.json({ error: "No active amenity catalogue" }, { status: 503 });
    return NextResponse.json(page, {
      headers: { "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400" },
    });
  } catch (error) {
    console.error("[api:catalogue-export] export failed", error);
    return NextResponse.json({ error: "Catalogue export unavailable" }, { status: 503 });
  }
}
