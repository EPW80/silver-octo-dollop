import type { D1Migration } from "cloudflare:test";

declare global {
  namespace Cloudflare {
    interface GlobalProps {
      mainModule: typeof import("../../src/index.js");
    }
    interface Env {
      DB: D1Database;
      BUCKET: R2Bucket;
      API_KEYS: string;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
