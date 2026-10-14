import { defineConfig, devices } from "@playwright/test";
import fs from "node:fs";

import { E2E_JOB_SECRET } from "./tests/e2e/fixtures/e2e";

// Cloud sessions ship Chromium at a fixed path; local installs use Playwright's own download.
const executablePath =
  process.env.PLAYWRIGHT_CHROMIUM_PATH ??
  (fs.existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);

const port = Number(process.env.E2E_PORT ?? 3100);
const baseURL = `http://127.0.0.1:${port}`;

/**
 * The signed-in suite (tests/e2e/signed-in) needs a local Supabase stack and `pnpm e2e:seed`; it is added only with
 * E2E_SIGNED_IN=1, so `pnpm e2e` without a stack runs the signed-out specs exactly as before. See tests/e2e/README.md.
 */
const signedIn = process.env.E2E_SIGNED_IN === "1";
/** CI builds once and serves the production build (`E2E_SERVER=start`); locally the dev server is used. */
const serveBuild = process.env.E2E_SERVER === "start";

const chrome = {
  ...devices["Desktop Chrome"],
  launchOptions: executablePath ? { executablePath } : {},
  // The production build registers public/sw.js, whose first activation claims the page and reloads it
  // (components/shell/pwa.tsx). Tests must not race that reload; the worker only caches build assets anyway.
  serviceWorkers: "block" as const,
};

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  expect: { timeout: signedIn ? 15_000 : 5_000 },
  fullyParallel: true,
  retries: process.env.CI && signedIn ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      testIgnore: /signed-in\//,
      use: chrome,
    },
    ...(signedIn
      ? [
          { name: "setup", testMatch: /signed-in\/auth\.setup\.ts/, use: chrome },
          {
            name: "signed-in",
            testMatch: /signed-in\/.*\.spec\.ts/,
            dependencies: ["setup"],
            use: chrome,
          },
        ]
      : []),
  ],
  webServer: {
    command: serveBuild ? `pnpm exec next start -p ${port}` : `pnpm exec next dev -p ${port}`,
    url: `${baseURL}/login`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "e2e-anon-key",
      SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "e2e-service-key",
      JOB_SECRET: E2E_JOB_SECRET,
      APP_URL: process.env.APP_URL ?? baseURL,
      NEXT_TELEMETRY_DISABLED: "1",
    },
  },
});
