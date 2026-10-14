import createBundleAnalyzer from "@next/bundle-analyzer";
import { withSentryConfig } from "@sentry/nextjs/config";
import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== "production";

/**
 * Where the browser SDK sends errors. Sentry's ingest hosts are oNNN.ingest.sentry.io and, for the US and EU regions,
 * oNNN.ingest.us.sentry.io / oNNN.ingest.de.sentry.io; the exact host of NEXT_PUBLIC_SENTRY_DSN is added when it is set.
 */
function sentryConnectSrc(): string {
  const hosts = new Set([
    "https://*.ingest.sentry.io",
    "https://*.ingest.us.sentry.io",
    "https://*.ingest.de.sentry.io",
  ]);
  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
  if (dsn) {
    try {
      const u = new URL(dsn);
      if (u.protocol === "https:") hosts.add(`https://${u.host}`);
    } catch {
      // A malformed DSN is reported by the SDK; the CSP keeps the defaults.
    }
  }
  return [...hosts].join(" ");
}

/**
 * CSP ships in report-only mode first: Next injects inline scripts and Sentry/Supabase
 * origins vary per project, so enforce it only after a week of clean reports
 * (docs/07_PHASE_11_NOTES.md). The other headers are enforced from day one.
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://*.supabase.co",
  "media-src 'self' blob: https://*.supabase.co",
  "font-src 'self' data:",
  `connect-src 'self' https://*.supabase.co wss://*.supabase.co ${sentryConnectSrc()}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
  "worker-src 'self'",
  "manifest-src 'self'",
].join("; ");

const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Voice notes use the microphone; nothing else needs a device API.
  { key: "Permissions-Policy", value: "microphone=(self), camera=(), geolocation=(), payment=()" },
  { key: "Content-Security-Policy-Report-Only", value: csp },
];

/**
 * Vercel's build machine has 8 GB. With the Sentry source-map upload on, Next's own type and lint pass after the compile
 * runs it out of memory (SIGKILL). GitHub CI gates every pull request on `pnpm typecheck`, `pnpm lint` and a full
 * `pnpm build` that still runs that pass, so only the Vercel build skips the repeat (docs/38_HOSTING_SETUP.md).
 */
const onVercel = process.env.VERCEL === "1";
/** The end-to-end workflow (.github/workflows/e2e.yml) skips it too: the CI checks job already runs both. */
const skipBuildChecks = onVercel || process.env.PULSE_SKIP_BUILD_CHECKS === "1";

const nextConfig: NextConfig = {
  typescript: { ignoreBuildErrors: skipBuildChecks },
  eslint: { ignoreDuringBuilds: skipBuildChecks },
  // unpdf bundles pdf.js, which uses `import.meta` in ways webpack cannot bundle. Load it from
  // node_modules at runtime instead (used only by the kb_ingest handler for PDF sources).
  serverExternalPackages: ["unpdf"],
  poweredByHeader: false,
  experimental: {
    // Campaign CSV audiences (up to 50k rows) are posted to a server action.
    serverActions: { bodySizeLimit: "16mb" },
  },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // The service worker must always be re-checked, or an update could be held back for a day by the HTTP cache.
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ];
  },
};

// `ANALYZE=true pnpm build` writes the bundle report to .next/analyze (see docs/13_PHASE_13_NOTES.md).
const withBundleAnalyzer = createBundleAnalyzer({
  enabled: process.env.ANALYZE === "true",
  openAnalyzer: false,
});

/**
 * Source maps go to Sentry only when SENTRY_AUTH_TOKEN (with SENTRY_ORG and SENTRY_PROJECT) is set at build time; they
 * are deleted from the output after upload. Without the token the build is exactly as before: no Sentry build plugin,
 * no upload, no extra loaders. Runtime reporting does not depend on this (instrumentation.ts).
 */
const uploadSourceMaps =
  !!process.env.SENTRY_AUTH_TOKEN && !!process.env.SENTRY_ORG && !!process.env.SENTRY_PROJECT;

const withSentry = (config: NextConfig): NextConfig =>
  uploadSourceMaps
    ? withSentryConfig(config, {
        org: process.env.SENTRY_ORG,
        project: process.env.SENTRY_PROJECT,
        authToken: process.env.SENTRY_AUTH_TOKEN,
        silent: !process.env.CI,
        telemetry: false,
        widenClientFileUpload: false,
        sourcemaps: { deleteSourcemapsAfterUpload: true },
      })
    : config;

export default withSentry(withBundleAnalyzer(nextConfig));
