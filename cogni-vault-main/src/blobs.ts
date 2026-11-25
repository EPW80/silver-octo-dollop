import type { ObjectBucket } from "./env.js";

export interface BlobStore {
  putText(key: string, text: string): Promise<void>;
  getText(key: string): Promise<string | null>;
  delete(key: string): Promise<void>;
}

export function r2BlobStore(bucket: ObjectBucket): BlobStore {
  return {
    async putText(key, text) {
      await bucket.put(key, text, {
        httpMetadata: { contentType: "text/plain; charset=utf-8" },
      });
    },
    async getText(key) {
      const object = await bucket.get(key);
      if (!object) return null;
      return object.text();
    },
    async delete(key) {
      await bucket.delete(key);
    },
  };
}
