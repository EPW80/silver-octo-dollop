import { auditStatement } from "./audit.js";
import { assertRole, type Actor } from "./auth.js";
import { decodeCursor, encodeCursor } from "./cursor.js";
import type { SqlDatabase, SqlStatement } from "./env.js";
import { BankError } from "./errors.js";
import {
  objectBody, optionalEmail, readCents, readCurrency, readEnumFilter, readIdempotencyKey,
  readLimit, readPaymentMethod, readText,
} from "./fields.js";
import { newId, sha256 } from "./ids.js";
import { validProviderRef, type PaymentKind, type PaymentProvider, type ProviderPayment } from "./stripe.js";

export const PAYMENT_STATUSES = ["pending", "executing", "needs_reconciliation", "executed", "rejected", "failed"] as const;
const PAYMENT_KINDS = ["charge", "refund"] as const;
const LEASE_MS = 60_000;
const RETRY_MS = 23 * 60 * 60_000;
const RESERVED = "('pending', 'executing', 'needs_reconciliation', 'executed')";
const RESERVED_CENTS = "COALESCE(SUM(COALESCE(settled_cents, amount_cents)), 0)";

export const SETTLED_ORDER_CENTS = `(
  SELECT COALESCE(SUM(CASE
    WHEN kind = 'charge' AND status = 'executed' THEN COALESCE(settled_cents, 0)
    WHEN kind = 'refund' THEN -COALESCE(settled_cents, amount_cents)
    ELSE 0 END), 0)
  FROM payment_requests WHERE order_id = orders.id AND currency = orders.currency
    AND status IN ('executed', 'executing', 'needs_reconciliation')
)`;

interface PaymentRow {
  id: string;
  kind: PaymentKind;
  order_id: string | null;
  charge_id: string | null;
  amount_cents: number;
  currency: string;
  customer_email: string;
  idempotency_key: string;
  payload_hash: string;
  status: typeof PAYMENT_STATUSES[number];
  reason: string;
  payment_method: string | null;
  provider: string;
  provider_ref: string | null;
  error: string | null;
  requested_by: string;
  decided_by: string | null;
  created_at: string;
  updated_at: string;
  first_attempt_at: string | null;
  attempt_id: string | null;
  lease_until: string | null;
  legacy_request: number;
  settled_cents: number | null;
}

const INSERT_PAYMENT = `INSERT INTO payment_requests (
  id, kind, order_id, charge_id, amount_cents, currency, customer_email, idempotency_key, payload_hash,
  status, reason, payment_method, requested_by, created_at, updated_at
)`;

export class PaymentService {
  constructor(
    private readonly db: SqlDatabase,
    private readonly provider: PaymentProvider | null,
    private readonly clock: () => string,
  ) {}

  async requestCharge(input: unknown, actor: Actor) {
    assertRole(actor, "operator");
    const body = objectBody(input);
    const amount = readCents(body.amount_cents, "amount_cents");
    const currency = readCurrency(body.currency);
    const orderId = body.order_id == null || body.order_id === "" ? null : validateOrderId(body.order_id, 404);
    const key = readIdempotencyKey(body.idempotency_key);
    const paymentMethod = readPaymentMethod(body.payment_method);
    const email = optionalEmail(body.customer_email);
    const reason = readText(body.reason, "reason", 500);
    const hash = await sha256(JSON.stringify({ kind: "charge", orderId, amount, currency, paymentMethod }));
    const matches = (row: PaymentRow) => row.payload_hash === hash;
    const existing = await this.findByKey(key);
    if (existing) return this.replay(existing, matches);
    if (!paymentMethod) throw paymentMethodRequired();

    const id = newId("pay");
    const now = this.clock();
    const reservation = this.db.prepare(
      `${INSERT_PAYMENT}
       SELECT ?, 'charge', ?, NULL, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?
       WHERE ? IS NULL OR EXISTS (
         SELECT 1 FROM orders
         WHERE id = ? AND status NOT IN ('cancelled', 'refunded') AND currency = ?
           AND total_cents >= ? + (
             SELECT ${RESERVED_CENTS} FROM payment_requests
             WHERE order_id = orders.id AND kind = 'charge' AND status IN ${RESERVED}
           )
       )
       ON CONFLICT(idempotency_key) DO NOTHING`,
    ).bind(id, orderId, amount, currency, email, key, hash, reason, paymentMethod, actor.bot, now, now,
      orderId, orderId, currency, amount);

    const row = await this.reserve(reservation, id, key, matches, actor, now);
    if (row) return publicPayment(row);
    const order = await this.db.prepare("SELECT status, currency FROM orders WHERE id = ?").bind(orderId)
      .first<{ status: string; currency: string }>();
    if (!order) throw new BankError("Order not found.", 404, "not_found");
    if (order.status === "cancelled" || order.status === "refunded") {
      throw new BankError(`Order is ${order.status} and cannot be charged.`, 409, "bad_transition");
    }
    if (order.currency !== currency) throw new BankError("Charge currency must match the order.", 400, "bad_currency");
    throw new BankError("Charges would exceed the order total.", 409, "too_much");
  }

  async requestRefund(input: unknown, actor: Actor) {
    assertRole(actor, "operator");
    const body = objectBody(input);
    const chargeId = readText(body.charge_id, "charge_id", 80, true);
    const key = readIdempotencyKey(body.idempotency_key);
    const requested = body.amount_cents == null ? null : readCents(body.amount_cents, "amount_cents");
    const reason = readText(body.reason, "reason", 500);
    const matches = (row: PaymentRow) =>
      row.kind === "refund" && row.charge_id === chargeId && (requested === null || row.amount_cents === requested);
    const existing = await this.findByKey(key);
    if (existing) return this.replay(existing, matches);

    const id = newId("pay");
    const now = this.clock();
    const hash = await sha256(JSON.stringify({ kind: "refund", chargeId, amount: requested }));
    const reservation = this.db.prepare(
      `WITH balance AS (
         SELECT charge.*, settled_cents - (
           SELECT ${RESERVED_CENTS} FROM payment_requests
           WHERE charge_id = charge.id AND kind = 'refund' AND status IN ${RESERVED}
         ) AS remaining
         FROM payment_requests AS charge
         WHERE id = ? AND kind = 'charge' AND status = 'executed' AND provider_ref IS NOT NULL AND settled_cents > 0
       )
       ${INSERT_PAYMENT}
       SELECT ?, 'refund', order_id, id, COALESCE(?, remaining), currency, customer_email,
              ?, ?, 'pending', ?, NULL, ?, ?, ?
       FROM balance WHERE remaining > 0 AND COALESCE(?, remaining) <= remaining
       ON CONFLICT(idempotency_key) DO NOTHING`,
    ).bind(chargeId, id, requested, key, hash, reason, actor.bot, now, now, requested);
    const row = await this.reserve(reservation, id, key, matches, actor, now);
    if (row) return publicPayment(row);

    const charge = await this.require(chargeId);
    verifiedCharge(charge);
    const balance = await this.db.prepare(
      `SELECT ${RESERVED_CENTS} AS total FROM payment_requests
       WHERE charge_id = ? AND kind = 'refund' AND status IN ${RESERVED}`,
    ).bind(chargeId).first<{ total: number }>();
    if ((charge.settled_cents ?? 0) <= Number(balance?.total ?? 0)) {
      throw new BankError("This charge has no balance left to refund.", 409, "nothing_left");
    }
    throw new BankError("Refund would exceed the remaining charge balance.", 409, "too_much");
  }

  async approve(id: string, actor: Actor, suppliedRef?: unknown) {
    assertRole(actor, "admin");
    const row = await this.require(id);
    const ref = this.approvalReference(row, suppliedRef);
    if (row.status === "executed" && row.settled_cents !== null) return publicPayment(row);

    const now = this.clock();
    const expired = row.lease_until === null || row.lease_until <= now;
    if (!expired) throw new BankError("Payment approval is in progress.", 409, "payment_in_progress");
    const legacyReconciliation = ref !== null && row.legacy_request === 1 && row.first_attempt_at === null &&
      (row.status === "executed" || row.status === "failed" || row.status === "rejected");
    if (!legacyReconciliation && !["pending", "executing", "needs_reconciliation"].includes(row.status)) {
      throw new BankError(`Transaction is ${row.status}.`, 409, "bad_transition");
    }

    const provider = this.provider;
    if (!provider) throw new BankError("Stripe is not configured.", 503, "stripe_not_configured");
    const paymentMethod = row.kind === "charge" && ref === null ? readPaymentMethod(row.payment_method) : null;
    if (row.kind === "charge" && ref === null && !paymentMethod) throw paymentMethodRequired();
    if (ref === null && row.legacy_request === 1) {
      throw new BankError("This legacy request requires reconciliation with a Stripe reference.", 409, "reconciliation_required");
    }
    const parentRef = row.kind === "refund" ? verifiedCharge(await this.require(row.charge_id ?? "")) : undefined;
    const post = ref === null;
    if (post && row.first_attempt_at !== null && Date.parse(now) - Date.parse(row.first_attempt_at) >= RETRY_MS) {
      await this.releaseExpiredLease(row, now);
      throw new BankError("The retry window has closed. Reconcile this request with a Stripe reference.", 409, "reconciliation_required");
    }

    const attemptId = newId("payrun");
    const leaseUntil = new Date(Date.parse(now) + LEASE_MS).toISOString();
    // Compare the attempt as well as the state so a stale caller cannot claim a newer lease.
    const claim = await this.db.prepare(
      `UPDATE payment_requests
       SET status = 'executing', first_attempt_at = COALESCE(first_attempt_at, ?), attempt_id = ?,
           lease_until = ?, updated_at = ?
       WHERE id = ? AND status = ? AND attempt_id IS ?
         AND (lease_until IS NULL OR lease_until <= ?)
         AND (? = 0 OR kind <> 'charge' OR order_id IS NULL OR EXISTS (
           SELECT 1 FROM orders WHERE id = payment_requests.order_id AND status NOT IN ('cancelled', 'refunded')
         ))`,
    ).bind(now, attemptId, leaseUntil, now, id, row.status, row.attempt_id, now, post ? 1 : 0).run();
    if (claim.meta?.changes !== 1) {
      const current = await this.require(id);
      if (current.status === "executed" && current.settled_cents !== null) return publicPayment(current);
      if (current.status === "executing" || current.attempt_id !== row.attempt_id) {
        throw new BankError("Payment approval is in progress.", 409, "payment_in_progress");
      }
      throw new BankError("The payment or linked order no longer permits approval.", 409, "bad_transition");
    }

    let result: ProviderPayment;
    try {
      result = ref !== null
        ? await provider.retrieve(row.kind, ref)
        : await this.sendPayment(provider, row, paymentMethod, parentRef);
      if (
        !validProviderRef(row.kind, result.id) || (ref !== null && result.id !== ref) ||
        result.kind !== row.kind || result.requestId !== id || result.amountCents !== row.amount_cents ||
        result.currency !== row.currency || (row.kind === "refund" && result.paymentIntentId !== parentRef) ||
        !Number.isSafeInteger(result.settledCents) || result.settledCents < 0 || result.settledCents > row.amount_cents
      ) {
        throw new BankError("Stripe returned an object that does not match this request.", 502, "provider_mismatch");
      }
    } catch (error) {
      await this.hold(row.id, attemptId, null, "Provider outcome requires reconciliation.");
      if (error instanceof BankError) throw error;
      throw new BankError("The provider outcome is unknown.", 502, "stripe_error");
    }

    const succeeded = result.status === "succeeded" && result.settledCents > 0;
    const failed = result.settledCents === 0 &&
      (result.status === "canceled" || (row.kind === "refund" && result.status === "failed"));
    if (!succeeded && !failed) {
      const held = await this.hold(id, attemptId, result.id, "Stripe has not reported a final outcome.");
      if (!held) throw paymentRecordFailed();
      return publicPayment(await this.require(id));
    }

    try {
      await this.finalize(row, attemptId, actor, result, succeeded, provider.name);
    } catch (error) {
      if (error instanceof BankError && error.code === "payment_in_progress") throw error;
      await this.hold(id, attemptId, result.id, "The provider outcome has not been recorded.");
      throw paymentRecordFailed();
    }
    return publicPayment(await this.require(id));
  }

  async reject(id: string, input: unknown, actor: Actor) {
    assertRole(actor, "admin");
    const row = await this.require(id);
    const reason = readText(objectBody(input).reason, "reason", 500);
    const now = this.clock();
    const [rejected] = await this.db.batch([
      this.db.prepare(
        `UPDATE payment_requests SET status = 'rejected', reason = ?, decided_by = ?, updated_at = ?
         WHERE id = ? AND status = 'pending'`,
      ).bind(reason || row.reason, actor.bot, now, id),
      auditStatement(this.db, { actor, action: "payment.reject", entityType: "payment", entityId: id, summary: reason }, now,
        { sql: "changes() = 1", params: [] }),
    ]);
    if (rejected?.meta?.changes !== 1) throw new BankError("Only a pending payment can be rejected.", 409, "bad_transition");
    return publicPayment(await this.require(id));
  }

  async get(id: string, actor: Actor) {
    assertRole(actor, "read");
    return publicPayment(await this.require(id));
  }

  async list(input: { status?: unknown; kind?: unknown; order_id?: unknown; limit?: unknown; cursor?: unknown }, actor: Actor) {
    assertRole(actor, "read");
    const status = readEnumFilter(input.status, PAYMENT_STATUSES, "status");
    const kind = readEnumFilter(input.kind, PAYMENT_KINDS, "kind");
    const orderId = input.order_id == null || input.order_id === "" ? null : validateOrderId(input.order_id, 400);
    const limit = readLimit(input.limit, 20, 100);
    const cursor = typeof input.cursor === "string" && input.cursor ? decodeCursor(input.cursor) : null;
    const filters: string[] = [];
    const params: unknown[] = [];
    for (const [field, value] of [["status", status], ["kind", kind], ["order_id", orderId]] as const) {
      if (value !== null) {
        filters.push(`${field} = ?`);
        params.push(value);
      }
    }
    if (cursor) {
      filters.push("(created_at, id) < (?, ?)");
      params.push(cursor.updatedAt, cursor.id);
    }
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    const { results } = await this.db.prepare(
      `SELECT * FROM payment_requests ${where} ORDER BY created_at DESC, id DESC LIMIT ?`,
    ).bind(...params, limit + 1).all<PaymentRow>();
    const page = (results ?? []).slice(0, limit);
    const last = page.at(-1);
    return {
      payments: page.map(publicPayment),
      next_cursor: last && (results?.length ?? 0) > limit ? encodeCursor(last.created_at, last.id) : null,
    };
  }

  private async reserve(
    reservation: SqlStatement, id: string, key: string, matches: (row: PaymentRow) => boolean, actor: Actor, now: string,
  ) {
    const [created] = await this.db.batch([
      reservation,
      auditStatement(this.db, { actor, action: "payment.request", entityType: "payment", entityId: id }, now,
        { sql: "EXISTS (SELECT 1 FROM payment_requests WHERE id = ?)", params: [id] }),
    ]);
    if (created?.meta?.changes === 1) return this.require(id);
    const existing = await this.findByKey(key);
    if (existing && !matches(existing)) throw idempotencyConflict();
    return existing;
  }

  private approvalReference(row: PaymentRow, suppliedRef: unknown): string | null {
    if (suppliedRef === undefined) return row.provider_ref;
    if (typeof suppliedRef !== "string" || !validProviderRef(row.kind, suppliedRef)) {
      throw new BankError("Invalid Stripe reference.", 400, "bad_provider_ref");
    }
    if (
      (row.provider_ref !== null && row.provider_ref !== suppliedRef) ||
      (row.status === "pending" && row.legacy_request === 0)
    ) {
      throw new BankError("This Stripe reference cannot be used for this payment.", 409, "bad_provider_ref");
    }
    return suppliedRef;
  }

  private async releaseExpiredLease(row: PaymentRow, now: string) {
    await this.db.prepare(
      `UPDATE payment_requests SET status = 'needs_reconciliation', lease_until = NULL, updated_at = ?,
              error = 'Stripe reference required after the retry window.'
       WHERE id = ? AND status = 'executing' AND attempt_id IS ? AND lease_until <= ?`,
    ).bind(now, row.id, row.attempt_id, now).run();
  }

  private sendPayment(provider: PaymentProvider, row: PaymentRow, paymentMethod: string | null, parentRef?: string) {
    if (row.kind === "charge" && paymentMethod) {
      return provider.charge({
        amountCents: row.amount_cents,
        currency: row.currency,
        idempotencyKey: row.idempotency_key,
        description: `House of Helix Peptides ${row.order_id ?? row.id}`,
        customerEmail: row.customer_email || undefined,
        orderId: row.order_id ?? undefined,
        requestId: row.id,
        paymentMethod,
      });
    }
    if (row.kind === "refund" && parentRef) {
      return provider.refund({
        amountCents: row.amount_cents,
        idempotencyKey: row.idempotency_key,
        paymentIntentId: parentRef,
        requestId: row.id,
        reason: row.reason,
      });
    }
    throw new BankError("Payment is missing its provider details.", 409, "bad_transition");
  }

  private async hold(id: string, attempt: string, ref: string | null, message: string): Promise<boolean> {
    try {
      const result = await this.db.prepare(
        `UPDATE payment_requests
         SET status = 'needs_reconciliation', provider_ref = COALESCE(?, provider_ref), error = ?, updated_at = ?
         WHERE id = ? AND attempt_id = ? AND status = 'executing'`,
      ).bind(ref, message, this.clock(), id, attempt).run();
      return result.meta?.changes === 1;
    } catch {
      // The original claim remains reserved and can be reclaimed after the lease expires.
      console.error("Payment reconciliation update failed", id);
      return false;
    }
  }

  private async finalize(
    row: PaymentRow, attempt: string, actor: Actor, result: ProviderPayment, succeeded: boolean, provider: string,
  ) {
    const now = this.clock();
    const status = succeeded ? "executed" : "failed";
    const won = {
      sql: "EXISTS (SELECT 1 FROM payment_requests WHERE id = ? AND attempt_id = ? AND status = ?)",
      params: [row.id, attempt, status],
    };
    const statements = [
      this.db.prepare(
        `UPDATE payment_requests
         SET status = ?, provider = ?, provider_ref = ?, settled_cents = ?, decided_by = ?,
             error = ?, lease_until = NULL, updated_at = ?
         WHERE id = ? AND attempt_id = ? AND status = 'executing'`,
      ).bind(status, provider, result.id, succeeded ? result.settledCents : null, actor.bot,
        succeeded ? null : "Stripe confirmed that no funds moved.", now, row.id, attempt),
      auditStatement(this.db, {
        actor, action: succeeded ? "payment.execute" : "payment.fail", entityType: "payment", entityId: row.id,
        summary: `${row.kind} ${result.settledCents} ${row.currency}`,
      }, now, won),
    ];
    if (row.order_id !== null && (succeeded || row.kind === "refund")) {
      statements.push(
        this.db.prepare(
          `UPDATE orders SET status = 'paid', updated_at = ?
           WHERE id = ? AND status = 'pending' AND ${won.sql} AND ${SETTLED_ORDER_CENTS} >= total_cents`,
        ).bind(now, row.order_id, ...won.params),
        this.db.prepare(
          `INSERT INTO order_status_events (id, order_id, from_status, to_status, note, actor, created_at)
           SELECT ?, ?, 'pending', 'paid', ?, ?, ? WHERE changes() = 1`,
        ).bind(newId("evt"), row.order_id, `Payment ${row.id} verified the order balance.`, actor.bot, now),
      );
    }
    const [updated] = await this.db.batch(statements);
    if (updated?.meta?.changes !== 1) throw new BankError("A different approval claimed this payment.", 409, "payment_in_progress");
  }

  private findByKey(key: string) {
    return this.db.prepare("SELECT * FROM payment_requests WHERE idempotency_key = ?").bind(key).first<PaymentRow>();
  }

  private replay(existing: PaymentRow, matches: (row: PaymentRow) => boolean) {
    if (!matches(existing)) throw idempotencyConflict();
    return publicPayment(existing);
  }

  private async require(id: string): Promise<PaymentRow> {
    if (!/^pay_[0-9a-f]{32}$/.test(id)) throw new BankError("Transaction not found.", 404, "not_found");
    const row = await this.db.prepare("SELECT * FROM payment_requests WHERE id = ?").bind(id).first<PaymentRow>();
    if (!row) throw new BankError("Transaction not found.", 404, "not_found");
    return row;
  }
}

function publicPayment(row: PaymentRow) {
  return {
    id: row.id, kind: row.kind, order_id: row.order_id, charge_id: row.charge_id,
    amount_cents: row.amount_cents, currency: row.currency, customer_email: row.customer_email,
    idempotency_key: row.idempotency_key, status: row.status, reason: row.reason, provider: row.provider,
    provider_ref: row.provider_ref, settled_cents: row.settled_cents, error: row.error,
    requested_by: row.requested_by, decided_by: row.decided_by, created_at: row.created_at, updated_at: row.updated_at,
  };
}

function validateOrderId(value: unknown, status: 400 | 404): string {
  if (typeof value !== "string" || !/^ord_[0-9a-f]{32}$/.test(value)) {
    throw new BankError("order_id is not an order.", status, status === 404 ? "not_found" : "bad_order_id");
  }
  return value;
}

function verifiedCharge(charge: PaymentRow): string {
  if (charge.kind !== "charge" || charge.status !== "executed" || !charge.provider_ref || !charge.settled_cents) {
    throw new BankError("Refunds require a charge with verified settlement.", 409, "bad_charge");
  }
  return charge.provider_ref;
}

function idempotencyConflict() {
  return new BankError("This idempotency key was already used for a different payment.", 409, "idempotency_conflict");
}

function paymentMethodRequired() {
  return new BankError("A Stripe payment_method (pm_...) is required.", 400, "payment_method_required");
}

function paymentRecordFailed() {
  return new BankError("Stripe responded but the outcome could not be recorded. Retry approval to reconcile it.", 502, "record_failed");
}
