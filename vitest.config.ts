import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
      "server-only": path.resolve(__dirname, "tests/stubs/server-only.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts", "tests/db/**/*.test.ts", "lib/**/*.test.ts"],
    exclude: ["tests/e2e/**", "node_modules/**"],
    setupFiles: ["tests/setup.ts"],
    testTimeout: 20_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    coverage: { provider: "v8", include: ["lib/**"] },
  },
});
