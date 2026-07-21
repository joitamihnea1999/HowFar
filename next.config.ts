import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Tree-shake barrel-style packages when the client pulls basemap style helpers.
  experimental: {
    optimizePackageImports: ["@protomaps/basemaps"],
  },
};

export default nextConfig;
