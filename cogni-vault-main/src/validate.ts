import { BankError } from "./errors.js";
import { objectBody } from "./fields.js";
import { byteLength } from "./text.js";

export const LIMITS = {
  title: 200,
  contentBytes: 1_000_000,
  tags: 32,
  tagLength: 40,
  source: 500,
  metadataBytes: 8_000,
  description: 500,
  query: 500,
  listDefault: 20,
  listMax: 100,
  searchDefault: 10,
  searchMax: 50,
  r2Threshold: 64 * 1024,
  excerptChars: 8000,
  semanticWindow: 500,
} as const;

export type ItemType = "note" | "doc" | "data";
export type SearchMode = "keyword" | "semantic" | "hybrid";

const TAG = /^[a-z0-9][a-z0-9:_./-]{0,39}$/;
const COLLECTION = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface NormalizedItem {
  title: string;
  content: string;
  type: ItemType;
  tags: string[];
  source: string;
  collection: string;
  metadata: Record<string, unknown>;
}

export interface ItemPatch {
  title?: string;
  content?: string;
  type?: ItemType;
  tags?: string[];
  source?: string;
  collection?: string;
  metadata?: Record<string, unknown>;
}

export function normalizeSave(input: unknown): NormalizedItem {
  const body = objectBody(input);
  const type = readType(body.type) ?? inferType(body.content);
  const content = normalizeContent(body.content, type, true);
  return {
    title: readTitle(body.title),
    content,
    type,
    tags: readTags(body.tags),
    source: readSource(body.source),
    collection: readCollection(body.collection, true),
    metadata: readMetadata(body.metadata),
  };
}

export function normalizePatch(input: unknown, currentType: ItemType): ItemPatch {
  const body = objectBody(input);
  const patch: ItemPatch = {};
  if ("title" in body) patch.title = readTitle(body.title);
  if ("type" in body) {
    const type = readType(body.type);
    if (!type) throw new BankError("type must be note, doc, or data.", 400, "bad_type");
    patch.type = type;
  }
  if ("content" in body) {
    patch.content = normalizeContent(body.content, patch.type ?? currentType, false);
  }
  if ("tags" in body) patch.tags = readTags(body.tags);
  if ("source" in body) patch.source = readSource(body.source);
  if ("collection" in body) patch.collection = readCollection(body.collection, false);
  if ("metadata" in body) patch.metadata = readMetadata(body.metadata);
  if (Object.keys(patch).length === 0) {
    throw new BankError("Provide at least one field to update.", 400, "empty_patch");
  }
  return patch;
}

/** When a patch changes type or content, re-check that data items are JSON. */
export function reconcileContent(type: ItemType, content: string): string {
  if (type !== "data") return content;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new BankError("type data requires content that is valid JSON.", 400, "bad_json");
  }
  const canonical = JSON.stringify(parsed);
  assertContentSize(canonical);
  return canonical;
}

export function requireCollectionName(input: unknown): string {
  if (typeof input !== "string" || !input.trim()) {
    throw new BankError("Collection name is required.", 400, "bad_collection");
  }
  return slugCollection(input);
}

export function readDescription(input: unknown): string {
  if (input == null) return "";
  if (typeof input !== "string") {
    throw new BankError("description must be a string.", 400, "bad_description");
  }
  const description = input.trim();
  if (description.length > LIMITS.description) {
    throw new BankError(`description must be at most ${LIMITS.description} characters.`, 400, "bad_description");
  }
  return description;
}

export function readSearchMode(input: unknown): SearchMode {
  if (input == null || input === "") return "hybrid";
  if (input === "keyword" || input === "semantic" || input === "hybrid") return input;
  throw new BankError("mode must be keyword, semantic, or hybrid.", 400, "bad_mode");
}

export function readQuery(input: unknown): string {
  if (typeof input !== "string" || !input.trim()) {
    throw new BankError("query is required.", 400, "bad_query");
  }
  const query = input.trim();
  if (query.length > LIMITS.query) {
    throw new BankError(`query must be at most ${LIMITS.query} characters.`, 400, "bad_query");
  }
  return query;
}

export function readItemTypeFilter(input: unknown): ItemType | undefined {
  if (input == null || input === "") return undefined;
  if (input === "note" || input === "doc" || input === "data") return input;
  throw new BankError("type must be note, doc, or data.", 400, "bad_type");
}

export function readAuthorFilter(input: unknown): string | undefined {
  if (input == null || input === "") return undefined;
  if (typeof input !== "string") throw new BankError("author must be a string.", 400, "bad_author");
  const author = input.trim();
  if (!author || author.length > 64) throw new BankError("author is invalid.", 400, "bad_author");
  return author;
}

export function readTagFilters(inputs: unknown[]): string[] {
  const tags: string[] = [];
  for (const input of inputs) {
    if (typeof input !== "string") throw new BankError("tags must be strings.", 400, "bad_tag");
    for (const part of input.split(",")) {
      const tag = part.trim().toLowerCase();
      if (!tag) continue;
      if (!TAG.test(tag)) {
        throw new BankError(
          `Tag "${part.trim()}" must be 1-${LIMITS.tagLength} characters: letters, numbers, and : _ . / -.`,
          400,
          "bad_tag",
        );
      }
      if (!tags.includes(tag)) tags.push(tag);
    }
  }
  if (tags.length > LIMITS.tags) {
    throw new BankError(`At most ${LIMITS.tags} tag filters.`, 400, "bad_tag");
  }
  return tags;
}

export function slugCollection(input: string): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[\s]+/g, "-")
    .replace(/[^a-z0-9_-]/g, "")
    .replace(/^[-_]+/, "")
    .slice(0, 64);
  if (!COLLECTION.test(slug)) {
    throw new BankError(
      "Collection names use letters, numbers, hyphens, and underscores, and must start with a letter or number.",
      400,
      "bad_collection",
    );
  }
  return slug;
}

function readTitle(input: unknown): string {
  if (typeof input !== "string") throw new BankError("title is required.", 400, "bad_title");
  const title = input.trim().replace(/\s+/g, " ");
  if (!title) throw new BankError("title is required.", 400, "bad_title");
  if (title.length > LIMITS.title) {
    throw new BankError(`title must be at most ${LIMITS.title} characters.`, 400, "bad_title");
  }
  return title;
}

function readType(input: unknown): ItemType | undefined {
  if (input == null || input === "") return undefined;
  if (input === "note" || input === "doc" || input === "data") return input;
  throw new BankError("type must be note, doc, or data.", 400, "bad_type");
}

function inferType(content: unknown): ItemType {
  return typeof content === "string" || content == null ? "note" : "data";
}

function normalizeContent(input: unknown, type: ItemType, required: boolean): string {
  if (input == null) {
    if (required) throw new BankError("content is required.", 400, "bad_content");
    throw new BankError("content cannot be null.", 400, "bad_content");
  }
  if (typeof input === "string") {
    if (type === "data") return canonicalizeJsonText(input);
    assertContentSize(input);
    return input;
  }
  if (type !== "data") {
    throw new BankError("Object content is only valid for type data. Pass a string, or set type to data.", 400, "bad_content");
  }
  let text: string;
  try {
    text = JSON.stringify(input);
  } catch {
    throw new BankError("content is not valid JSON.", 400, "bad_json");
  }
  if (text === undefined) throw new BankError("content is not valid JSON.", 400, "bad_json");
  assertContentSize(text);
  return text;
}

function canonicalizeJsonText(input: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new BankError("type data requires content that is valid JSON.", 400, "bad_json");
  }
  const text = JSON.stringify(parsed);
  assertContentSize(text);
  return text;
}

function assertContentSize(text: string): void {
  if (byteLength(text) > LIMITS.contentBytes) {
    throw new BankError(`content must be at most ${LIMITS.contentBytes} bytes.`, 400, "bad_content");
  }
}

function readTags(input: unknown): string[] {
  if (input == null) return [];
  if (!Array.isArray(input)) throw new BankError("tags must be an array of strings.", 400, "bad_tag");
  return readTagFilters(input.map((tag) => {
    if (typeof tag !== "string") throw new BankError("tags must be an array of strings.", 400, "bad_tag");
    return tag;
  }));
}

function readSource(input: unknown): string {
  if (input == null) return "";
  if (typeof input !== "string") throw new BankError("source must be a string.", 400, "bad_source");
  const source = input.trim();
  if (source.length > LIMITS.source) {
    throw new BankError(`source must be at most ${LIMITS.source} characters.`, 400, "bad_source");
  }
  return source;
}

function readCollection(input: unknown, allowDefault: boolean): string {
  if (input == null || input === "") {
    if (allowDefault) return "inbox";
    throw new BankError("collection is required.", 400, "bad_collection");
  }
  if (typeof input !== "string") throw new BankError("collection must be a string.", 400, "bad_collection");
  return slugCollection(input);
}

function readMetadata(input: unknown): Record<string, unknown> {
  if (input == null) return {};
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new BankError("metadata must be a JSON object.", 400, "bad_metadata");
  }
  const text = JSON.stringify(input);
  if (byteLength(text) > LIMITS.metadataBytes) {
    throw new BankError(`metadata must be at most ${LIMITS.metadataBytes} bytes.`, 400, "bad_metadata");
  }
  return input as Record<string, unknown>;
}
