import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // unpdf bundles pdf.js, which uses `import.meta` in ways webpack cannot bundle. Load it from
  // node_modules at runtime instead (used only by the kb_ingest handler for PDF sources).
  serverExternalPackages: ["unpdf"],
};

export default nextConfig;
