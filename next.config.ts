import type { NextConfig } from "next";

import { parseAllowedDevOrigins } from "./src/lib/dev-origins";

const nextConfig: NextConfig = {
  // Tree-shake barrel-style packages when the client pulls basemap style helpers.
  experimental: {
    optimizePackageImports: ["@protomaps/basemaps"],
  },
  // LAN device testing (dev only): set ALLOWED_DEV_ORIGINS to the host's LAN
  // hostname/IP so the dev server accepts cross-origin requests from a phone on
  // the same network (see docs/SELFHOST.md). Unset → undefined → default behaviour
  // (only localhost), byte-identical to having no key.
  allowedDevOrigins: parseAllowedDevOrigins(process.env.ALLOWED_DEV_ORIGINS),
};

export default nextConfig;
