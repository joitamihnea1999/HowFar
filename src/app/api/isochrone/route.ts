import { NextResponse } from "next/server";

import { parsePaceStrict } from "@/features/isochrones/pace";
import { parseReachModelStrict, WALK_PRESET_MIN } from "@/features/isochrones/preset-reach";
import { walkingIsochrone, walkingPresetIsochrone } from "@/features/isochrones/server/ors";
import { errorResponse, jsonError, outOfAreaGuard, parseLatLng } from "@/lib/api-util";
import { ProviderError } from "@/lib/provider-http";

const WALK_PRESET_CHIPS = new Set<number>(WALK_PRESET_MIN);

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = parseLatLng(url);
  if (parsed instanceof NextResponse) return parsed;
  const outside = outOfAreaGuard(parsed.lat, parsed.lng);
  if (outside) return outside;
  const pace = parsePaceStrict(url.searchParams.get("pace"));
  if (pace === null) return jsonError(400, "Invalid pace");
  const model = parseReachModelStrict(url.searchParams.get("model"));
  if (model === null) return jsonError(400, "Invalid model");
  try {
    if (model === "preset") {
      // `walkingPresetIsochrone` fetches the full [10,20,40] set (40 exists ONLY
      // for the transit street-walk union). The walk ROUTE serves only the
      // selectable chips [10,20] — the 40-min contour is NOT a walk reach and was
      // deliberately held out of the served honesty bar, so it must never leave
      // this route as a labelled walk ring.
      const preset = await walkingPresetIsochrone(parsed.lat, parsed.lng, pace);
      const rings = preset.rings.filter((r) => WALK_PRESET_CHIPS.has(r.minutes));
      // Fail LOUD rather than return an empty reach: if the chips and the fetched
      // set ever drift apart (a one-token constant edit), a silent 200 with zero
      // rings would look like "nowhere is reachable" to the client — a 502 is honest.
      if (rings.length !== WALK_PRESET_MIN.length) {
        throw new ProviderError(
          `preset walk slice produced ${rings.length} of ${WALK_PRESET_MIN.length} chips — WALK_PRESET_MIN drifted from the fetched set`,
        );
      }
      return NextResponse.json({ ...preset, rings });
    }
    return NextResponse.json(await walkingIsochrone(parsed.lat, parsed.lng, pace));
  } catch (err) {
    return errorResponse(err, "isochrone");
  }
}
