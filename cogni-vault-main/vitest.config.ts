import { defineConfig } from "vitest/config";

// Two projects:
// - node: fast unit tests against node:sqlite and an in-memory bucket (test/helpers.ts).
// - workers: the real Worker inside workerd with local D1 and R2 (vitest.workers.config.ts).
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: ["test/**/*.test.ts"],
          exclude: ["test/workers/**"],
          testTimeout: 20_000,
        },
      },
      "./vitest.workers.config.ts",
    ],
  },
});
