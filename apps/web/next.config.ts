import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @vouch/shared ships raw TypeScript source; Next compiles it in-place.
  transpilePackages: ["@vouch/shared"],
};

export default nextConfig;
