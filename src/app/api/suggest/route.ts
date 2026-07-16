import { NextResponse } from "next/server";

import { errorResponse } from "@/lib/api-util";
import { suggest } from "@/lib/providers/photon";

export const dynamic = "force-dynamic";

const MIN_QUERY_LEN = 3;

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  // Below the min length, return empty without hitting the provider — the
  // client also guards this, but the server must not depend on that.
  if (q.length < MIN_QUERY_LEN) return NextResponse.json({ suggestions: [] });
  try {
    const suggestions = await suggest(q);
    return NextResponse.json({ suggestions });
  } catch (err) {
    return errorResponse(err, "suggest");
  }
}
