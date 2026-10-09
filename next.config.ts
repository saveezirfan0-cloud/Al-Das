import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Campaign CSV audiences (up to 50k rows) are posted to a server action.
    serverActions: { bodySizeLimit: "16mb" },
  },
};

export default nextConfig;
