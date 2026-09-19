import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    include: ["tests/integration/**/*.test.ts"],
    setupFiles: ["tests/unit/setup.ts"],
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
