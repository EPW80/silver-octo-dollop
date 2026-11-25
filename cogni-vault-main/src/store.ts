import type { BlobStore } from "./blobs.js";
import { decodeCursor, encodeCursor } from "./cursor.js";
import type { SqlDatabase } from "./env.js";
import { BankError } from "./errors.js";
import { bytesToFloat32, cosine, embed, embedDocument, float32ToBytes } from "./embed.js";
import { readLimit } from "./fields.js";
import { byteLength, preview, toFtsQuery, tokenize } from "./text.js";
import {
  LIMITS,
  readAuthorFilter,
  readDescription,
  readItemTypeFilter,
  readQuery,
  readSearchMode,
  readTagFilters,
  reconcileContent,
  requireCollectionName,
  normalizePatch,
  normalizeSave,
  slugCollection,
  type ItemType,
  type SearchMode,
} from "./validate.js";

export interface Item {
  id: string;
  collection: string;
  type: ItemType;
  title: string;
  content: string;
  excerpt: string;
  tags: string[];
  source: string;
  author: string;
  updated_by: string;
  metadata: Record<string, unknown>;
  bytes: number;
  storage: "d1" | "r2";
  created_at: string;
  updated_at: string;
}

export type ItemSummary = Omit<Item, "content" | "metadata">;

export interface SearchHit extends ItemSummary {
  score: number;
}

export interface Collection {
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
  items: number;
}

interface ItemRow {
  id: string;
  collection: string;
  type: ItemType;
  title: string;
  body: string | null;
  excerpt: string;
  r2_key: string | null;
  bytes: number;
  tags: string;
  source: string;
  author: string;
  updated_by: string;
  metadata: string;
  embedding: unknown;
  created_at: string;
  updated_at: string;
}

interface Filter {
  collection?: string;
  type?: ItemType;
  author?: string;
  tags: string[];
}

export interface StoreOptions {
  r2Threshold?: number;
  semanticWindow?: number;
  clock?: () => string;
}

const SUMMARY_COLUMNS = `id, collection, type, title, excerpt, tags, source, author, updated_by, bytes, r2_key, created_at, updated_at`;

export class BankStore {
  private readonly r2Threshold: number;
  private readonly semanticWindow: number;
  private readonly clock: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly blobs: BlobStore,
    options: StoreOptions = {},
  ) {
    this.r2Threshold = options.r2Threshold ?? LIMITS.r2Threshold;
    this.semanticWindow = options.semanticWindow ?? LIMITS.semanticWindow;
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  async listCollections(): Promise<Collection[]> {
    const { results } = await this.db
      .prepare(
        `SELECT c.name, c.description, c.created_at, c.updated_at,
                (SELECT COUNT(*) FROM items i WHERE i.collection = c.name) AS items
         FROM collections c
         ORDER BY c.name`,
      )
      .all<{
        name: string;
        description: string;
        created_at: string;
        updated_at: string;
        items: number;
      }>();
    return (results ?? []).map((row) => ({ ...row, items: Number(row.items) }));
  }

  async createCollection(nameInput: unknown, descriptionInput: unknown): Promise<Collection> {
    const name = requireCollectionName(nameInput);
    const description = readDescription(descriptionInput);
    const ts = this.clock();
    try {
      await this.db
        .prepare(
          `INSERT INTO collections (name, description, created_at, updated_at) VALUES (?, ?, ?, ?)`,
        )
        .bind(name, description, ts, ts)
        .run();
    } catch (error) {
      if (isUnique(error)) throw new BankError(`Collection "${name}" already exists.`, 409, "conflict");
      throw error;
    }
    return { name, description, created_at: ts, updated_at: ts, items: 0 };
  }

  async deleteCollection(nameInput: unknown, force: boolean): Promise<{ name: string; deleted_items: number }> {
    const name = requireCollectionName(nameInput);
    if (name === "inbox") {
      throw new BankError("The inbox collection cannot be deleted.", 400, "protected");
    }
    const existing = await this.db.prepare(`SELECT name FROM collections WHERE name = ?`).bind(name).first();
    if (!existing) throw new BankError(`Collection "${name}" not found.`, 404, "not_found");

    const countRow = await this.db
      .prepare(`SELECT COUNT(*) AS n FROM items WHERE collection = ?`)
      .bind(name)
      .first<{ n: number }>();
    const count = Number(countRow?.n ?? 0);
    if (count > 0 && !force) {
      throw new BankError(
        `Collection "${name}" still has ${count} item${count === 1 ? "" : "s"}. Pass force to delete them too.`,
        409,
        "not_empty",
      );
    }

    const blobs = await this.db
      .prepare(`SELECT r2_key FROM items WHERE collection = ? AND r2_key IS NOT NULL`)
      .bind(name)
      .all<{ r2_key: string }>();
    await this.db.prepare(`DELETE FROM items WHERE collection = ?`).bind(name).run();
    for (const row of blobs.results ?? []) {
      await this.blobs.delete(row.r2_key);
    }
    await this.db.prepare(`DELETE FROM collections WHERE name = ?`).bind(name).run();
    return { name, deleted_items: count };
  }

  async saveItem(input: unknown, actor: string): Promise<Item> {
    const item = normalizeSave(input);
    const ts = this.clock();
    await this.ensureCollection(item.collection, ts);
    const id = newItemId();
    const stored = await this.writeBody(id, item.content, null);
    const embedding = float32ToBytes(embedDocument(item.title, item.tags, item.content));
    try {
      await this.db
        .prepare(
          `INSERT INTO items (
             id, collection, type, title, body, excerpt, r2_key, bytes, tags, source,
             author, updated_by, metadata, embedding, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          id,
          item.collection,
          item.type,
          item.title,
          stored.body,
          stored.excerpt,
          stored.r2Key,
          stored.bytes,
          JSON.stringify(item.tags),
          item.source,
          actor,
          actor,
          JSON.stringify(item.metadata),
          embedding,
          ts,
          ts,
        )
        .run();
    } catch (error) {
      if (stored.r2Key && stored.r2Key !== null) await this.blobs.delete(stored.r2Key).catch(() => undefined);
      throw error;
    }
    return this.getItem(id);
  }

  async getItem(id: string): Promise<Item> {
    const row = await this.requireRow(id);
    const content = await this.readContent(row);
    return toItem(row, content);
  }

  async updateItem(id: string, input: unknown, actor: string): Promise<Item> {
    const current = await this.requireRow(id);
    const currentContent = await this.readContent(current);
    const patch = normalizePatch(input, current.type);
    const ts = this.clock();

    const title = patch.title ?? current.title;
    const type = patch.type ?? current.type;
    let content = patch.content ?? currentContent;
    if (patch.content === undefined && patch.type) content = reconcileContent(type, content);
    const tags = patch.tags ?? parseTags(current.tags);
    const source = patch.source ?? current.source;
    const collection = patch.collection ?? current.collection;
    const metadata = patch.metadata ?? parseMetadata(current.metadata);

    if (collection !== current.collection) await this.ensureCollection(collection, ts);

    const contentChanged = content !== currentContent;
    const reembed = contentChanged || title !== current.title || JSON.stringify(tags) !== current.tags;
    const stored = contentChanged ? await this.writeBody(id, content, current.r2_key) : null;
    const embedding = reembed
      ? float32ToBytes(embedDocument(title, tags, content))
      : preserveBytes(current.embedding);

    try {
      await this.db
        .prepare(
          `UPDATE items SET
             collection = ?, type = ?, title = ?, body = ?, excerpt = ?, r2_key = ?, bytes = ?,
             tags = ?, source = ?, updated_by = ?, metadata = ?, embedding = ?, updated_at = ?
           WHERE id = ?`,
        )
        .bind(
          collection,
          type,
          title,
          stored ? stored.body : current.body,
          stored ? stored.excerpt : current.excerpt,
          stored ? stored.r2Key : current.r2_key,
          stored ? stored.bytes : current.bytes,
          JSON.stringify(tags),
          source,
          actor,
          JSON.stringify(metadata),
          embedding,
          ts,
          id,
        )
        .run();
    } catch (error) {
      if (stored?.r2Key && stored.r2Key !== current.r2_key) {
        await this.blobs.delete(stored.r2Key).catch(() => undefined);
      }
      throw error;
    }

    if (stored && current.r2_key && current.r2_key !== stored.r2Key) {
      await this.blobs.delete(current.r2_key);
    }
    return this.getItem(id);
  }

  async deleteItem(id: string): Promise<{ id: string; deleted: true }> {
    const row = await this.requireRow(id);
    await this.db.prepare(`DELETE FROM items WHERE id = ?`).bind(id).run();
    if (row.r2_key) await this.blobs.delete(row.r2_key);
    return { id, deleted: true };
  }

  async listItems(input: {
    collection?: unknown;
    type?: unknown;
    author?: unknown;
    tags?: unknown[];
    limit?: unknown;
    cursor?: unknown;
  }): Promise<{ items: ItemSummary[]; next_cursor: string | null }> {
    const filter = this.readFilter(input);
    const limit = readLimit(input.limit, LIMITS.listDefault, LIMITS.listMax);
    const cursor = typeof input.cursor === "string" && input.cursor ? decodeCursor(input.cursor) : null;
    const { sql, params } = whereSql(filter, "items");
    const cursorSql = cursor ? ` AND (updated_at < ? OR (updated_at = ? AND id < ?))` : "";
    const cursorParams = cursor ? [cursor.updatedAt, cursor.updatedAt, cursor.id] : [];
    const { results } = await this.db
      .prepare(
        `SELECT ${SUMMARY_COLUMNS} FROM items
         WHERE 1 = 1${sql}${cursorSql}
         ORDER BY updated_at DESC, id DESC
         LIMIT ?`,
      )
      .bind(...params, ...cursorParams, limit + 1)
      .all<ItemRow>();
    return page(results ?? [], limit);
  }

  async searchItems(input: {
    query: unknown;
    mode?: unknown;
    collection?: unknown;
    type?: unknown;
    author?: unknown;
    tags?: unknown[];
    limit?: unknown;
  }): Promise<{ items: SearchHit[]; mode: SearchMode }> {
    const query = readQuery(input.query);
    const mode = readSearchMode(input.mode);
    const filter = this.readFilter(input);
    const limit = readLimit(input.limit, LIMITS.searchDefault, LIMITS.searchMax);
    if (tokenize(query).length === 0) {
      throw new BankError("Query has no searchable terms. Use words of at least 2 characters.", 400, "bad_query");
    }

    const keywordLimit = mode === "keyword" ? limit : 40;
    const similarLimit = mode === "semantic" ? limit : 40;
    // Keyword and semantic hits are independent reads. Running them in parallel halves the latency
    // of the default hybrid search instead of paying both round-trips in sequence.
    const keywordRead: Promise<ItemSummary[]> =
      mode === "semantic" ? Promise.resolve([]) : this.keywordHits(query, filter, keywordLimit);
    const similarRead: Promise<SearchHit[]> =
      mode === "keyword" ? Promise.resolve([]) : this.similarHits(query, filter, similarLimit);
    const [keyword, similar] = await Promise.all([keywordRead, similarRead]);

    if (mode === "keyword") {
      return { mode, items: keyword.map((hit, index) => ({ ...hit, score: round(1 / (1 + index)) })) };
    }
    if (mode === "semantic") {
      return { mode, items: similar.slice(0, limit) };
    }

    const byId = new Map<string, SearchHit>();
    keyword.forEach((hit, index) => {
      byId.set(hit.id, { ...hit, score: 0.6 * (1 / (1 + index)) });
    });
    for (const hit of similar) {
      const existing = byId.get(hit.id);
      if (existing) existing.score = round(existing.score + 0.4 * hit.score);
      else byId.set(hit.id, { ...hit, score: round(0.4 * hit.score) });
    }
    const items = [...byId.values()].sort((a, b) => b.score - a.score || b.updated_at.localeCompare(a.updated_at));
    return { mode, items: items.slice(0, limit).map((hit) => ({ ...hit, score: round(hit.score) })) };
  }

  private async keywordHits(query: string, filter: Filter, limit: number): Promise<ItemSummary[]> {
    const match = toFtsQuery(query);
    if (!match) return [];
    const { sql, params } = whereSql(filter, "items");
    try {
      const { results } = await this.db
        .prepare(
          `SELECT ${SUMMARY_COLUMNS.split(", ").map((column) => `items.${column}`).join(", ")}
           FROM items_fts
           JOIN items ON items.rowid = items_fts.rowid
           WHERE items_fts MATCH ?${sql}
           ORDER BY bm25(items_fts)
           LIMIT ?`,
        )
        .bind(match, ...params, limit)
        .all<ItemRow>();
      return (results ?? []).map(toSummary);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/fts5|malformed/i.test(message)) {
        throw new BankError("Search query could not be parsed.", 400, "bad_query");
      }
      throw error;
    }
  }

  private async similarHits(query: string, filter: Filter, limit: number): Promise<SearchHit[]> {
    const probe = embed(query);
    const { sql, params } = whereSql(filter, "items");
    const { results } = await this.db
      .prepare(
        `SELECT ${SUMMARY_COLUMNS}, embedding FROM items
         WHERE embedding IS NOT NULL${sql}
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .bind(...params, this.semanticWindow)
      .all<ItemRow>();

    const hits: SearchHit[] = [];
    for (const row of results ?? []) {
      const vector = bytesToFloat32(row.embedding);
      if (!vector) continue;
      const score = round(cosine(probe, vector));
      // Drop non-matches before building a summary, so a 500-row scan allocates only the few hits.
      if (score <= 0.05) continue;
      hits.push({ ...toSummary(row), score });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  private readFilter(input: {
    collection?: unknown;
    type?: unknown;
    author?: unknown;
    tags?: unknown[];
  }): Filter {
    let collection: string | undefined;
    if (typeof input.collection === "string" && input.collection.trim()) {
      collection = slugCollection(input.collection);
    } else if (input.collection != null && input.collection !== "") {
      throw new BankError("collection must be a string.", 400, "bad_collection");
    }
    return {
      collection,
      type: readItemTypeFilter(input.type),
      author: readAuthorFilter(input.author),
      tags: readTagFilters(input.tags ?? []),
    };
  }

  private async ensureCollection(name: string, ts: string): Promise<void> {
    const existing = await this.db.prepare(`SELECT name FROM collections WHERE name = ?`).bind(name).first();
    if (existing) return;
    try {
      await this.db
        .prepare(`INSERT INTO collections (name, description, created_at, updated_at) VALUES (?, '', ?, ?)`)
        .bind(name, ts, ts)
        .run();
    } catch (error) {
      if (isUnique(error)) return;
      throw error;
    }
  }

  private async requireRow(id: string): Promise<ItemRow> {
    if (!/^itm_[0-9a-f]{32}$/.test(id)) throw new BankError("Item not found.", 404, "not_found");
    const row = await this.db.prepare(`SELECT * FROM items WHERE id = ?`).bind(id).first<ItemRow>();
    if (!row) throw new BankError("Item not found.", 404, "not_found");
    return row;
  }

  private async readContent(row: ItemRow): Promise<string> {
    if (row.body != null) return row.body;
    if (!row.r2_key) return "";
    const text = await this.blobs.getText(row.r2_key);
    if (text == null) throw new BankError("The document body is missing from object storage.", 500, "missing_blob");
    return text;
  }

  private async writeBody(
    id: string,
    content: string,
    previousKey: string | null,
  ): Promise<{ body: string | null; excerpt: string; r2Key: string | null; bytes: number }> {
    const bytes = byteLength(content);
    const excerpt = content.slice(0, LIMITS.excerptChars);
    if (bytes <= this.r2Threshold) {
      return { body: content, excerpt, r2Key: null, bytes };
    }
    const r2Key = previousKey ?? `items/${id}`;
    await this.blobs.putText(r2Key, content);
    return { body: null, excerpt, r2Key, bytes };
  }
}

function whereSql(filter: Filter, table: string): { sql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.collection) {
    clauses.push(`${table}.collection = ?`);
    params.push(filter.collection);
  }
  if (filter.type) {
    clauses.push(`${table}.type = ?`);
    params.push(filter.type);
  }
  if (filter.author) {
    clauses.push(`${table}.author = ?`);
    params.push(filter.author);
  }
  for (const tag of filter.tags) {
    clauses.push(`EXISTS (SELECT 1 FROM json_each(${table}.tags) WHERE json_each.value = ?)`);
    params.push(tag);
  }
  return { sql: clauses.length ? ` AND ${clauses.join(" AND ")}` : "", params };
}

function page(rows: ItemRow[], limit: number): { items: ItemSummary[]; next_cursor: string | null } {
  const hasMore = rows.length > limit;
  const slice = hasMore ? rows.slice(0, limit) : rows;
  const last = slice[slice.length - 1];
  return {
    items: slice.map(toSummary),
    next_cursor: hasMore && last ? encodeCursor(last.updated_at, last.id) : null,
  };
}

function toSummary(row: ItemRow): ItemSummary {
  return {
    id: row.id,
    collection: row.collection,
    type: row.type,
    title: row.title,
    excerpt: preview(row.excerpt || row.body || ""),
    tags: parseTags(row.tags),
    source: row.source,
    author: row.author,
    updated_by: row.updated_by,
    bytes: Number(row.bytes),
    storage: row.r2_key ? "r2" : "d1",
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toItem(row: ItemRow, content: string): Item {
  return {
    ...toSummary(row),
    content,
    metadata: parseMetadata(row.metadata),
  };
}

function parseTags(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === "string") : [];
  } catch {
    return [];
  }
}

function parseMetadata(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    return {};
  } catch {
    return {};
  }
}

function preserveBytes(value: unknown): Uint8Array | null {
  const vector = bytesToFloat32(value);
  return vector ? float32ToBytes(vector) : null;
}

function newItemId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return `itm_${hex}`;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function isUnique(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /UNIQUE constraint failed/i.test(message);
}
