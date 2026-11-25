import { assertRole, type Actor } from "./auth.js";
import { auditStatement } from "./audit.js";
import { decodeCursor, encodeCursor } from "./cursor.js";
import type { SqlDatabase, SqlStatement } from "./env.js";
import { BankError } from "./errors.js";
import {
  objectBody,
  readCents,
  readCurrency,
  readEnumFilter,
  readQuantity,
  readSku,
  readText,
  readDelta,
  readLimit,
} from "./fields.js";
import { newId } from "./ids.js";
import { applyStock, stockStatements } from "./stock.js";

const RESTOCK_STATUSES = ["draft", "approved", "received", "cancelled"] as const;

interface ProductRow {
  sku: string;
  title: string;
  description: string;
  price_cents: number;
  currency: string;
  stock: number;
  low_stock_threshold: number;
  active: number;
  created_at: string;
  updated_at: string;
}

interface RestockSummary {
  id: string;
  status: string;
  supplier: string;
  notes: string;
  created_by: string;
  approved_by: string | null;
  created_at: string;
  updated_at: string;
}

export class InventoryService {
  constructor(
    private readonly db: SqlDatabase,
    private readonly clock: () => string,
  ) {}

  async upsertProduct(input: unknown, actor: Actor) {
    assertRole(actor, "operator");
    const body = objectBody(input);
    const sku = readSku(body.sku);
    const now = this.clock();
    const existing = await this.db.prepare("SELECT sku FROM products WHERE sku = ?").bind(sku).first();

    if (!existing) {
      const title = readText(body.title, "title", 200, true);
      const description = readText(body.description, "description", 4000);
      const price = readCents(body.price_cents ?? 0, "price_cents", true);
      const currency = readCurrency(body.currency);
      const threshold = readCents(body.low_stock_threshold ?? 0, "low_stock_threshold", true);
      const active = body.active == null ? 1 : readActive(body.active);
      const opening = body.stock == null ? 0 : readCents(body.stock, "stock", true);
      const statements: SqlStatement[] = [
        this.db
          .prepare(
            `INSERT INTO products (sku, title, description, price_cents, currency, stock, low_stock_threshold, active, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
          )
          .bind(sku, title, description, price, currency, threshold, active, now, now),
      ];
      if (opening > 0) {
        // The insert and the opening-stock adjustment commit together, so a SKU never exists with
        // a stock count that its ledger does not explain.
        statements.push(...stockStatements(this.db, { sku, delta: opening, reason: "opening stock", actor, now }));
      }
      statements.push(auditStatement(this.db, { actor, action: "product.upsert", entityType: "product", entityId: sku, summary: title }, now));
      await this.db.batch(statements);
      return this.getProduct(sku, actor);
    }

    const title = "title" in body ? readText(body.title, "title", 200, true) : null;
    const description = "description" in body ? readText(body.description, "description", 4000) : null;
    const price = "price_cents" in body ? readCents(body.price_cents, "price_cents", true) : null;
    const currency = "currency" in body ? readCurrency(body.currency) : null;
    const threshold = "low_stock_threshold" in body ? readCents(body.low_stock_threshold, "low_stock_threshold", true) : null;
    const active = body.active == null ? null : readActive(body.active);
    const target = body.stock == null ? null : readCents(body.stock, "stock", true);
    const statements: SqlStatement[] = [];
    if (target !== null) {
      statements.push(this.db.prepare(
        `INSERT INTO stock_adjustments (id, sku, delta, stock_after, reason, actor, created_at)
         SELECT ?, sku, ? - stock, ?, 'stock count', ?, ? FROM products WHERE sku = ? AND stock <> ?`,
      ).bind(newId("adj"), target, target, actor.bot, now, sku, target));
    }
    statements.push(
      this.db.prepare(
        `UPDATE products
         SET title = COALESCE(?, title), description = COALESCE(?, description),
             price_cents = COALESCE(?, price_cents), currency = COALESCE(?, currency),
             low_stock_threshold = COALESCE(?, low_stock_threshold), active = COALESCE(?, active),
             stock = COALESCE(?, stock), updated_at = ?
         WHERE sku = ?`,
      ).bind(title, description, price, currency, threshold, active, target, now, sku),
      auditStatement(this.db, { actor, action: "product.upsert", entityType: "product", entityId: sku, summary: title ?? undefined }, now),
    );
    await this.db.batch(statements);
    return this.getProduct(sku, actor);
  }

  async getProduct(skuInput: unknown, actor: Actor) {
    assertRole(actor, "read");
    const sku = readSku(skuInput);
    const row = await this.db.prepare(`SELECT * FROM products WHERE sku = ?`).bind(sku).first<ProductRow>();
    if (!row) throw new BankError(`Unknown sku ${sku}.`, 404, "not_found");
    return { ...row, active: Boolean(row.active), low: row.stock <= row.low_stock_threshold };
  }

  async listProducts(lowOnly: boolean, actor: Actor) {
    assertRole(actor, "read");
    const { results } = await this.db
      .prepare(
        `SELECT * FROM products
         WHERE (? = 0 OR (active = 1 AND stock <= low_stock_threshold))
         ORDER BY sku`,
      )
      .bind(lowOnly ? 1 : 0)
      .all<ProductRow>();
    return {
      products: (results ?? []).map((row) => ({
        ...row,
        active: Boolean(row.active),
        low: row.stock <= row.low_stock_threshold,
      })),
    };
  }

  async adjust(input: unknown, actor: Actor) {
    assertRole(actor, "operator");
    const body = objectBody(input);
    const sku = readSku(body.sku);
    const delta = readDelta(body.delta);
    const reason = readText(body.reason, "reason", 200, true);
    const now = this.clock();
    const stockAfter = await applyStock(
      this.db, { sku, delta, reason, actor, now },
      auditStatement(this.db, { actor, action: "stock.adjust", entityType: "product", entityId: sku, summary: `${delta} (${reason})` }, now),
    );
    return { sku, delta, stock: stockAfter };
  }

  async lowStock(actor: Actor) {
    return this.listProducts(true, actor);
  }

  async createRestock(input: unknown, actor: Actor) {
    assertRole(actor, "operator");
    const body = objectBody(input);
    const supplier = readText(body.supplier, "supplier", 200);
    const notes = readText(body.notes, "notes", 2000);
    const lines = this.readRestockLines(body.lines);
    const skus = [...new Set(lines.map(({ sku }) => sku))];
    const { results } = await this.db.prepare(
      `SELECT sku FROM products WHERE sku IN (${skus.map(() => "?").join(", ")})`,
    ).bind(...skus).all<{ sku: string }>();
    const available = new Set((results ?? []).map(({ sku }) => sku));
    const missing = skus.find((sku) => !available.has(sku));
    if (missing) throw new BankError(`Unknown sku ${missing}.`, 404, "not_found");
    const now = this.clock();
    const id = newId("rso");
    await this.db.batch([
      this.db.prepare(
        `INSERT INTO restock_orders (id, status, supplier, notes, created_by, created_at, updated_at)
         VALUES (?, 'draft', ?, ?, ?, ?, ?)`,
      ).bind(id, supplier, notes, actor.bot, now, now),
      ...lines.map((line) => this.db.prepare(
        `INSERT INTO restock_lines (id, restock_id, sku, quantity, unit_cost_cents) VALUES (?, ?, ?, ?, ?)`,
      ).bind(newId("rsl"), id, line.sku, line.quantity, line.unit_cost_cents)),
      auditStatement(this.db, { actor, action: "restock.create", entityType: "restock", entityId: id, summary: supplier }, now),
    ]);
    return this.getRestock(id, actor);
  }

  async approveRestock(id: string, actor: Actor) {
    assertRole(actor, "admin");
    const order = await this.requireRestock(id);
    if (order.status !== "draft") throw new BankError(`Restock ${id} is ${order.status}, not draft.`, 409, "bad_transition");
    const now = this.clock();
    const [updated] = await this.db.batch([
      this.db.prepare(
        `UPDATE restock_orders SET status = 'approved', approved_by = ?, updated_at = ? WHERE id = ? AND status = 'draft'`,
      ).bind(actor.bot, now, id),
      auditStatement(this.db, { actor, action: "restock.approve", entityType: "restock", entityId: id }, now,
        { sql: "changes() = 1", params: [] }),
    ]);
    if (updated?.meta?.changes !== 1) {
      throw new BankError(`Restock ${id} changed while this approval was being applied.`, 409, "bad_transition");
    }
    return this.getRestock(id, actor);
  }

  async receiveRestock(id: string, actor: Actor) {
    assertRole(actor, "operator");
    const order = await this.requireRestock(id);
    if (order.status !== "approved") {
      throw new BankError(`Restock ${id} must be approved before it can be received.`, 409, "bad_transition");
    }
    const lines = await this.restockLines(id);
    const now = this.clock();
    const auditId = newId("aud");
    const won = { sql: "EXISTS (SELECT 1 FROM audit_log WHERE id = ?)", params: [auditId] };
    const [claimed] = await this.db.batch([
      this.db.prepare(
        `UPDATE restock_orders SET status = 'received', updated_at = ? WHERE id = ? AND status = 'approved'`,
      ).bind(now, id),
      auditStatement(this.db, { actor, action: "restock.receive", entityType: "restock", entityId: id }, now,
        { sql: "changes() = 1", params: [] }, auditId),
      ...lines.flatMap((line) => stockStatements(this.db, {
        sku: line.sku, delta: line.quantity, reason: `restock ${id}`, actor, now, restockId: id,
      }, undefined, won)),
    ]);
    if (claimed?.meta?.changes !== 1) {
      throw new BankError(`Restock ${id} changed while this receipt was being applied.`, 409, "bad_transition");
    }
    return this.getRestock(id, actor);
  }

  async cancelRestock(id: string, actor: Actor) {
    const order = await this.requireRestock(id);
    if (order.status === "draft") assertRole(actor, "operator");
    else if (order.status === "approved") assertRole(actor, "admin");
    else throw new BankError(`Restock ${id} is ${order.status} and cannot be cancelled.`, 409, "bad_transition");
    const now = this.clock();
    const [updated] = await this.db.batch([
      this.db.prepare(
        `UPDATE restock_orders SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = ?`,
      ).bind(now, id, order.status),
      auditStatement(this.db, { actor, action: "restock.cancel", entityType: "restock", entityId: id }, now,
        { sql: "changes() = 1", params: [] }),
    ]);
    if (updated?.meta?.changes !== 1) {
      throw new BankError(`Restock ${id} changed while this cancellation was being applied.`, 409, "bad_transition");
    }
    return this.getRestock(id, actor);
  }

  async getRestock(id: string, actor: Actor) {
    assertRole(actor, "read");
    const order = await this.requireRestock(id);
    return { ...order, lines: await this.restockLines(id) };
  }

  /** The purchase-order queue. Without this a draft or approved restock can only be reached by id. */
  async listRestocks(input: { status?: unknown; limit?: unknown; cursor?: unknown }, actor: Actor) {
    assertRole(actor, "read");
    const status = readEnumFilter(input.status, RESTOCK_STATUSES, "status");
    const limit = readLimit(input.limit, 20, 100);
    const cursor = typeof input.cursor === "string" && input.cursor ? decodeCursor(input.cursor) : null;
    const filters = [status === null ? null : "status = ?", cursor ? "(created_at, id) < (?, ?)" : null].filter(Boolean);
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    const params = [...(status === null ? [] : [status]), ...(cursor ? [cursor.updatedAt, cursor.id] : [])];
    const { results } = await this.db
      .prepare(
        `SELECT id, status, supplier, notes, created_by, approved_by, created_at, updated_at
         FROM restock_orders
         ${where}
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .bind(...params, limit + 1)
      .all<RestockSummary>();
    const rows = results ?? [];
    const hasMore = rows.length > limit;
    const slice = hasMore ? rows.slice(0, limit) : rows;
    const last = slice[slice.length - 1];
    return {
      restocks: slice,
      next_cursor: hasMore && last ? encodeCursor(last.created_at, last.id) : null,
    };
  }

  private async requireRestock(id: string) {
    if (!/^rso_[0-9a-f]{32}$/.test(id)) throw new BankError("Restock order not found.", 404, "not_found");
    const row = await this.db
      .prepare(`SELECT id, status, supplier, notes, created_by, approved_by, created_at, updated_at FROM restock_orders WHERE id = ?`)
      .bind(id)
      .first<{
        id: string;
        status: string;
        supplier: string;
        notes: string;
        created_by: string;
        approved_by: string | null;
        created_at: string;
        updated_at: string;
      }>();
    if (!row) throw new BankError("Restock order not found.", 404, "not_found");
    return row;
  }

  private async restockLines(id: string) {
    const { results } = await this.db
      .prepare(`SELECT id, sku, quantity, unit_cost_cents FROM restock_lines WHERE restock_id = ? ORDER BY sku, id`)
      .bind(id)
      .all<{ id: string; sku: string; quantity: number; unit_cost_cents: number }>();
    return results ?? [];
  }

  private readRestockLines(input: unknown): { sku: string; quantity: number; unit_cost_cents: number }[] {
    if (!Array.isArray(input) || input.length === 0 || input.length > 50) {
      throw new BankError("lines must be an array of 1 to 50 restock rows.", 400, "bad_lines");
    }
    return input.map((entry) => {
      const row = objectBody(entry);
      return {
        sku: readSku(row.sku),
        quantity: readQuantity(row.quantity),
        unit_cost_cents: readCents(row.unit_cost_cents ?? 0, "unit_cost_cents", true),
      };
    });
  }
}

function readActive(input: unknown): number {
  if (input === true || input === 1 || input === "true" || input === "1") return 1;
  if (input === false || input === 0 || input === "false" || input === "0") return 0;
  throw new BankError("active must be true or false.", 400, "bad_active");
}
