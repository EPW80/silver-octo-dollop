import { assertRole, type Actor } from "./auth.js";
import { auditStatement } from "./audit.js";
import type { SqlDatabase, SqlStatement } from "./env.js";
import { BankError } from "./errors.js";
import { objectBody, readCents, readEmail, readLimit, readQuantity, readSku, readText } from "./fields.js";
import { newId } from "./ids.js";
import { SETTLED_ORDER_CENTS } from "./payments.js";
import { stockStatements } from "./stock.js";

const TRANSITIONS: Record<string, string[]> = {
  pending: ["paid", "fulfilling", "cancelled"],
  paid: ["fulfilling", "shipped", "cancelled", "refunded"],
  fulfilling: ["shipped", "cancelled"],
  shipped: ["delivered"],
  delivered: ["refunded"],
  cancelled: [],
  refunded: [],
};

const RESTOCK_ON_CANCEL = new Set(["pending", "paid", "fulfilling"]);

interface ProductRow {
  sku: string;
  title: string;
  price_cents: number;
  currency: string;
  active: number;
}

interface OrderRow {
  id: string;
  customer_email: string;
  customer_name: string;
  status: string;
  currency: string;
  subtotal_cents: number;
  shipping_cents: number;
  tax_cents: number;
  total_cents: number;
  notes: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface LineRow {
  id: string;
  sku: string;
  title: string;
  quantity: number;
  unit_price_cents: number;
}

export class OrderService {
  constructor(
    private readonly db: SqlDatabase,
    private readonly clock: () => string,
  ) {}

  async create(input: unknown, actor: Actor) {
    assertRole(actor, "operator");
    const body = objectBody(input);
    const email = readEmail(body.customer_email);
    const name = readText(body.customer_name, "customer_name", 120);
    const notes = readText(body.notes, "notes", 2000);
    const shipping = readCents(body.shipping_cents ?? 0, "shipping_cents", true);
    const tax = readCents(body.tax_cents ?? 0, "tax_cents", true);
    const lines = this.readLines(body.lines);
    const priced = await this.priceLines(lines);
    const first = priced[0];
    if (!first) throw new BankError("lines must be an array of 1 to 50 { sku, quantity } rows.", 400, "bad_lines");
    const subtotal = priced.reduce((sum, line) => sum + line.quantity * line.unit_price_cents, 0);
    const total = subtotal + shipping + tax;
    const now = this.clock();
    const id = newId("ord");

    // One transaction: stock reservations, the order, its lines, and the first history event.
    // If any statement fails (a negative stock CHECK, a missing sku), nothing is committed.
    const statements: SqlStatement[] = [];
    for (const line of priced) {
      statements.push(
        ...stockStatements(this.db, {
          sku: line.sku,
          delta: -line.quantity,
          reason: `order ${id}`,
          actor,
          now,
          orderId: id,
        }),
      );
    }
    statements.push(
      this.db
        .prepare(
          `INSERT INTO orders (
             id, customer_email, customer_name, status, currency, subtotal_cents, shipping_cents,
             tax_cents, total_cents, notes, created_by, created_at, updated_at
           ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(id, email, name, first.currency, subtotal, shipping, tax, total, notes, actor.bot, now, now),
    );
    for (const line of priced) {
      statements.push(
        this.db
          .prepare(
            `INSERT INTO order_lines (id, order_id, sku, title, quantity, unit_price_cents) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .bind(newId("lin"), id, line.sku, line.title, line.quantity, line.unit_price_cents),
      );
    }
    statements.push(
      this.db
        .prepare(
          `INSERT INTO order_status_events (id, order_id, from_status, to_status, note, actor, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(newId("evt"), id, null, "pending", "Order placed.", actor.bot, now),
      auditStatement(this.db, { actor, action: "order.create", entityType: "order", entityId: id }, now),
    );

    try {
      await this.db.batch(statements);
    } catch (error) {
      throw await this.explainStockFailure(error, priced);
    }

    return this.get(id, actor);
  }

  async get(id: string, actor: Actor) {
    assertRole(actor, "read");
    const order = await this.require(id);
    const lines = await this.db
      .prepare(`SELECT id, sku, title, quantity, unit_price_cents FROM order_lines WHERE order_id = ? ORDER BY id`)
      .bind(id)
      .all<LineRow>();
    const history = await this.db
      .prepare(
        `SELECT id, from_status, to_status, note, actor, created_at FROM order_status_events WHERE order_id = ? ORDER BY created_at, id`,
      )
      .bind(id)
      .all();
    return { ...order, lines: lines.results ?? [], history: history.results ?? [] };
  }

  async updateStatus(id: string, input: unknown, actor: Actor) {
    assertRole(actor, "operator");
    const body = objectBody(input);
    const next = readText(body.status, "status", 40, true);
    const note = readText(body.note, "note", 500);
    const order = await this.require(id);
    const allowed = TRANSITIONS[order.status] ?? [];
    if (!allowed.includes(next)) {
      throw new BankError(`Cannot move an order from ${order.status} to ${next}.`, 409, "bad_transition");
    }
    const now = this.clock();
    const closing = next === "cancelled" || next === "refunded";
    const eventId = newId("evt");
    const won = {
      sql: "EXISTS (SELECT 1 FROM order_status_events WHERE id = ?)",
      params: [eventId],
    };
    const statements = [
      this.db.prepare(
        `UPDATE orders SET status = ?, updated_at = ? WHERE id = ? AND status = ?
         AND (? = 0 OR NOT EXISTS (
           SELECT 1 FROM payment_requests WHERE order_id = orders.id AND kind = 'charge'
           AND status IN ('executing', 'needs_reconciliation')
         ))
         AND (? = 0 OR ${SETTLED_ORDER_CENTS} >= total_cents)`,
      ).bind(next, now, id, order.status, closing ? 1 : 0, next === "paid" ? 1 : 0),
      this.db.prepare(
        `INSERT INTO order_status_events (id, order_id, from_status, to_status, note, actor, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1`,
      ).bind(eventId, id, order.status, next, note, actor.bot, now),
    ];
    if (next === "cancelled" && RESTOCK_ON_CANCEL.has(order.status)) {
      const lines = await this.lines(id);
      for (const line of lines) {
        statements.push(...stockStatements(this.db, {
          sku: line.sku, delta: line.quantity, reason: `cancel ${id}`, actor, now, orderId: id,
        }, undefined, won));
      }
    }
    statements.push(auditStatement(this.db,
      { actor, action: "order.status", entityType: "order", entityId: id, summary: `${order.status} -> ${next}` },
      now, won,
    ));
    const [claimed] = await this.db.batch(statements);
    if (claimed?.meta?.changes !== 1) {
      const message = closing ? "The order changed or has an unresolved charge."
        : next === "paid" ? "The order changed or lacks verified settlement." : "The order changed during this update.";
      throw new BankError(message, 409, "bad_transition");
    }
    return this.get(id, actor);
  }

  async lookup(input: { email?: unknown; status?: unknown; limit?: unknown }, actor: Actor) {
    assertRole(actor, "read");
    const email = input.email == null || input.email === "" ? null : readEmail(input.email);
    const status = input.status == null || input.status === "" ? null : String(input.status);
    if (status && !Object.hasOwn(TRANSITIONS, status)) throw new BankError("Unknown order status.", 400, "bad_status");
    const limit = readLimit(input.limit, 20, 100);
    const filters = [email === null ? null : "customer_email = ?", status === null ? null : "status = ?"].filter(Boolean);
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    const { results } = await this.db
      .prepare(
        `SELECT id, customer_email, customer_name, status, currency, total_cents, created_at, updated_at
         FROM orders
         ${where}
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .bind(...[email, status].filter((value) => value !== null), limit)
      .all();
    return { orders: results ?? [] };
  }

  async require(id: string): Promise<OrderRow> {
    if (!/^ord_[0-9a-f]{32}$/.test(id)) throw new BankError("Order not found.", 404, "not_found");
    const row = await this.db.prepare(`SELECT * FROM orders WHERE id = ?`).bind(id).first<OrderRow>();
    if (!row) throw new BankError("Order not found.", 404, "not_found");
    return row;
  }

  private async lines(id: string): Promise<LineRow[]> {
    const { results } = await this.db
      .prepare(`SELECT id, sku, title, quantity, unit_price_cents FROM order_lines WHERE order_id = ?`)
      .bind(id)
      .all<LineRow>();
    return results ?? [];
  }

  private readLines(input: unknown): { sku: string; quantity: number }[] {
    if (!Array.isArray(input) || input.length === 0 || input.length > 50) {
      throw new BankError("lines must be an array of 1 to 50 { sku, quantity } rows.", 400, "bad_lines");
    }
    const merged = new Map<string, number>();
    for (const entry of input) {
      const row = objectBody(entry);
      const sku = readSku(row.sku);
      const quantity = readQuantity(row.quantity);
      merged.set(sku, (merged.get(sku) ?? 0) + quantity);
    }
    return [...merged].map(([sku, quantity]) => ({ sku, quantity }));
  }

  /** Turns a batch constraint failure into the reason a caller should see. The batch rolled back. */
  private async explainStockFailure(error: unknown, lines: { sku: string; quantity: number }[]): Promise<unknown> {
    const message = error instanceof Error ? error.message : String(error);
    if (!/constraint/i.test(message)) return error;
    try {
      for (const line of lines) {
        const row = await this.db
          .prepare(`SELECT stock FROM products WHERE sku = ?`)
          .bind(line.sku)
          .first<{ stock: number }>();
        if (!row) return new BankError(`Unknown or inactive sku ${line.sku}.`, 404, "not_found");
        if (Number(row.stock) < line.quantity) {
          return new BankError(`Not enough stock for ${line.sku}.`, 409, "insufficient_stock");
        }
      }
    } catch {
      return error;
    }
    return error;
  }

  private async priceLines(lines: { sku: string; quantity: number }[]) {
    const skus = lines.map(({ sku }) => sku);
    const { results } = await this.db.prepare(
      `SELECT sku, title, price_cents, currency, active FROM products WHERE sku IN (${skus.map(() => "?").join(", ")})`,
    ).bind(...skus).all<ProductRow>();
    const products = new Map((results ?? []).map((product) => [product.sku, product]));
    const priced = [];
    let currency = "";
    for (const line of lines) {
      const product = products.get(line.sku);
      if (!product?.active) throw new BankError(`Unknown or inactive sku ${line.sku}.`, 404, "not_found");
      if (!currency) currency = product.currency;
      if (product.currency !== currency) {
        throw new BankError("Every line in an order must use the same currency.", 400, "bad_currency");
      }
      priced.push({
        sku: product.sku,
        title: product.title,
        quantity: line.quantity,
        unit_price_cents: product.price_cents,
        currency: product.currency,
      });
    }
    return priced;
  }

}
