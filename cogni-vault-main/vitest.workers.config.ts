import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig(async () => {
  const migrations = await readD1Migrations(`${root}migrations`);
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: `${root}wrangler.jsonc` },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            API_KEYS:
              "local-bot:dbk_test_workers_operator:operator,reader-bot:dbk_test_workers_reader:read,admin-bot:dbk_test_workers_admin:admin",
          },
        },
      }),
    ],
    test: {
      name: "workers",
      include: ["test/workers/**/*.test.ts"],
      setupFiles: ["./test/workers/apply-migrations.ts"],
      testTimeout: 20_000,
    },
  };
});
