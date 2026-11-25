import { tokenize } from "./text.js";

/** Feature-hash width. 256 is enough for a personal corpus and keeps rows small. */
export const EMBED_DIM = 256;

const EXCERPT_CHARS = 8000;

/**
 * Signed feature hashing (a hashed bag of words and word pairs).
 * Vectors are L2-normalized so cosine similarity is a dot product.
 * This is lexical similarity, not a neural embedding: shared vocabulary
 * ranks higher, synonyms do not.
 */
export function embed(text: string): Float32Array {
  const vec = new Float32Array(EMBED_DIM);
  const tokens = tokenize(text);
  if (tokens.length === 0) return vec;

  const features = tokens.slice();
  for (let i = 0; i < tokens.length - 1; i++) {
    features.push(`${tokens[i]}_${tokens[i + 1]}`);
  }

  for (const feature of features) {
    const bucket = fnv(feature, 2166136261) % EMBED_DIM;
    const sign = (fnv(feature, 16777619) & 1) === 0 ? 1 : -1;
    vec[bucket] += sign;
  }

  let sum = 0;
  for (const value of vec) sum += value * value;
  const norm = Math.sqrt(sum);
  if (norm > 0) {
    for (let i = 0; i < EMBED_DIM; i++) vec[i] /= norm;
  }
  return vec;
}

export function embedDocument(title: string, tags: string[], content: string): Float32Array {
  return embed(`${title}\n${tags.join(" ")}\n${content.slice(0, EXCERPT_CHARS)}`);
}

export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot;
}

export function float32ToBytes(vec: Float32Array): Uint8Array {
  const bytes = new Uint8Array(vec.byteLength);
  bytes.set(new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength));
  return bytes;
}

export function bytesToFloat32(value: unknown): Float32Array | null {
  if (value == null) return null;

  // D1 returns SQL blobs as plain number arrays of bytes, not Uint8Array.
  if (Array.isArray(value)) {
    if (
      value.length === EMBED_DIM &&
      value.every((entry) => typeof entry === "number") &&
      value.some((entry) => typeof entry === "number" && !Number.isInteger(entry))
    ) {
      return Float32Array.from(value);
    }
    const bytes = byteArray(value);
    return bytes ? float32FromBytes(bytes) : null;
  }

  if (value instanceof ArrayBuffer) return float32FromBytes(new Uint8Array(value));
  if (ArrayBuffer.isView(value)) {
    return float32FromBytes(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  if (typeof value === "object" && value !== null && "byteLength" in value && "buffer" in value) {
    const view = value as ArrayBufferView;
    return float32FromBytes(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  }
  return null;
}

function byteArray(values: unknown[]): Uint8Array | null {
  if (values.length === 0 || values.length % 4 !== 0) return null;
  const bytes = new Uint8Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const entry = values[i];
    if (typeof entry !== "number" || !Number.isInteger(entry) || entry < -128 || entry > 255) return null;
    bytes[i] = entry < 0 ? entry + 256 : entry;
  }
  return bytes;
}

function float32FromBytes(bytes: Uint8Array): Float32Array | null {
  if (bytes.byteLength === 0 || bytes.byteLength % 4 !== 0) return null;
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Float32Array(copy.buffer);
}

function fnv(text: string, seed: number): number {
  let hash = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
