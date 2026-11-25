import type { Actor } from "./auth.js";
import type { SqlDatabase, SqlStatement } from "./env.js";
import { BankError } from "./errors.js";
import { newId } from "./ids.js";

export interface StockChange {
  sku: string;
  delta: number;
  reason: string;
  actor: Actor;
  now: string;
  orderId?: string | null;
  restockId?: string | null;
}

/**
 * The two statements a stock change always writes: the row update and its ledger entry.
 * `stock_after` is read with a subquery, so both can run in one transaction and neither needs a
 * round-trip in between. Returns statements, so a caller can batch them with its own writes.
 *
 * A negative delta is rejected by the `stock >= 0` CHECK constraint, which aborts the whole batch.
 */
export function stockStatements(
  db: SqlDatabase, input: StockChange, id = newId("adj"), condition?: { sql: string; params: unknown[] },
): [SqlStatement, SqlStatement] {
  const guard = condition ? ` AND ${condition.sql}` : "";
  const update = db
    .prepare(`UPDATE products SET stock = stock + ?, updated_at = ? WHERE sku = ?${guard}`)
    .bind(input.delta, input.now, input.sku, ...(condition?.params ?? []));
  const adjustment = db
    .prepare(
      `INSERT INTO stock_adjustments (id, sku, delta, stock_after, reason, order_id, restock_id, actor, created_at)
       SELECT ?, ?, ?, (SELECT stock FROM products WHERE sku = ?), ?, ?, ?, ?, ?
       ${condition ? `WHERE ${condition.sql}` : ""}`,
    )
    .bind(
      id,
      input.sku,
      input.delta,
      input.sku,
      input.reason,
      input.orderId ?? null,
      input.restockId ?? null,
      input.actor.bot,
      input.now,
      ...(condition?.params ?? []),
    );
  return [update, adjustment];
}

/** Turns the constraint failure a stock batch raises into the error the caller should see. */
export function translateStockError(error: unknown, sku: string, exists: boolean): never {
  if (!exists) throw new BankError(`Unknown sku ${sku}.`, 404, "not_found");
  const message = error instanceof Error ? error.message : String(error);
  if (/CHECK constraint/i.test(message)) {
    throw new BankError(`Not enough stock for ${sku}.`, 409, "insufficient_stock");
  }
  throw error;
}

export async function applyStock(db: SqlDatabase, input: StockChange, audit: SqlStatement): Promise<number> {
  const id = newId("adj");
  try {
    await db.batch([...stockStatements(db, input, id), audit]);
  } catch (error) {
    let exists: boolean;
    try {
      exists = Boolean(await db.prepare(`SELECT sku FROM products WHERE sku = ?`).bind(input.sku).first());
    } catch {
      throw error;
    }
    translateStockError(error, input.sku, exists);
  }
  const row = await db.prepare("SELECT stock_after FROM stock_adjustments WHERE id = ?")
    .bind(id).first<{ stock_after: number }>();
  if (!row) throw new Error("Stock adjustment was not recorded.");
  return Number(row.stock_after);
}
