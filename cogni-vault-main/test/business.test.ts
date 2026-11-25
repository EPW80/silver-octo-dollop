import { describe, expect, it } from "vitest";
import { App } from "../src/app.js";
import type { Actor } from "../src/auth.js";
import { BankError } from "../src/errors.js";
import { sha256 } from "../src/ids.js";
import { StripeProvider, type ChargeInput, type PaymentKind, type PaymentProvider, type ProviderPayment, type RefundInput } from "../src/stripe.js";
import { createBucket, createDatabase, sequencedClock, withFailingWrites } from "./helpers.js";

const read: Actor = { bot: "reader", role: "read" };
const operator: Actor = { bot: "ops", role: "operator" };
const admin: Actor = { bot: "owner", role: "admin" };

class MockStripe implements PaymentProvider {
  readonly name = "stripe";
  charges: ChargeInput[] = [];
  refunds: RefundInput[] = [];
  payments = new Map<string, ProviderPayment>();
  retrievals: string[] = [];

  async charge(input: ChargeInput): Promise<ProviderPayment> {
    this.charges.push(input);
    const payment: ProviderPayment = {
      id: `pi_mock_${this.charges.length}`, kind: "charge", status: "succeeded",
      requestId: input.requestId, amountCents: input.amountCents, settledCents: input.amountCents, currency: input.currency,
    };
    this.payments.set(payment.id, payment);
    return payment;
  }

  async refund(input: RefundInput): Promise<ProviderPayment> {
    this.refunds.push(input);
    const payment: ProviderPayment = {
      id: `re_mock_${this.refunds.length}`, kind: "refund", status: "succeeded",
      requestId: input.requestId, amountCents: input.amountCents, settledCents: input.amountCents,
      currency: this.payments.get(input.paymentIntentId)?.currency ?? "usd", paymentIntentId: input.paymentIntentId,
    };
    this.payments.set(payment.id, payment);
    return payment;
  }

  async retrieve(_kind: PaymentKind, id: string): Promise<ProviderPayment> {
    this.retrievals.push(id);
    const payment = this.payments.get(id);
    if (!payment) throw new Error("Unknown mock payment.");
    return payment;
  }
}

function shop(stripe: PaymentProvider | null = null) {
  const clock = sequencedClock();
  const app = new App(createDatabase(), createBucket(), { clock, provider: stripe, r2Threshold: 64 });
  return { app, clock };
}

async function catalog(app: App, stock = 10) {
  await app.inventory.upsertProduct(
    { sku: "bpc-10", title: "BPC-157 10mg", price_cents: 4900, stock, low_stock_threshold: 4 },
    operator,
  );
}

describe("orders and inventory", () => {
  it("prices from the catalog, reserves stock, and records status history", async () => {
    const { app } = shop();
    await catalog(app, 10);
    const order = await app.orders.create(
      {
        customer_email: "Ada@helix.test",
        customer_name: "Ada",
        lines: [{ sku: "bpc-10", quantity: 2 }, { sku: "BPC-10", quantity: 1 }],
        shipping_cents: 500,
      },
      operator,
    );
    expect(order.customer_email).toBe("ada@helix.test");
    expect(order.lines).toHaveLength(1);
    expect(order.lines[0]).toMatchObject({ sku: "BPC-10", quantity: 3, unit_price_cents: 4900 });
    expect(order.subtotal_cents).toBe(14700);
    expect(order.total_cents).toBe(15200);
    expect(order.history.map((event) => event.to_status)).toEqual(["pending"]);
    expect((await app.inventory.getProduct("BPC-10", read)).stock).toBe(7);

    const byEmail = await app.orders.lookup({ email: "ada@helix.test" }, read);
    expect(byEmail.orders.map((row) => row.id)).toEqual([order.id]);

    await expect(app.orders.create({ customer_email: "ada@helix.test", lines: [{ sku: "BPC-10", quantity: 100 }] }, operator))
      .rejects.toMatchObject({ code: "insufficient_stock" });
    expect((await app.inventory.getProduct("BPC-10", read)).stock).toBe(7);

    const cancelled = await app.orders.updateStatus(order.id, { status: "cancelled", note: "customer changed their mind" }, operator);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.history.map((event) => event.to_status)).toEqual(["pending", "cancelled"]);
    expect((await app.inventory.getProduct("BPC-10", read)).stock).toBe(10);
  });

  it("adjusts stock, reports low stock, and only receives an approved restock", async () => {
    const { app } = shop();
    await catalog(app, 10);
    expect((await app.inventory.adjust({ sku: "BPC-10", delta: -7, reason: "damaged vials" }, operator)).stock).toBe(3);
    const low = await app.inventory.lowStock(read);
    expect(low.products.map((product) => product.sku)).toEqual(["BPC-10"]);

    const restock = await app.inventory.createRestock(
      { supplier: "Lab supply", lines: [{ sku: "BPC-10", quantity: 20, unit_cost_cents: 1800 }] },
      operator,
    );
    expect(restock.status).toBe("draft");
    await expect(app.inventory.receiveRestock(restock.id, operator)).rejects.toMatchObject({ code: "bad_transition" });
    await expect(app.inventory.approveRestock(restock.id, operator)).rejects.toMatchObject({ status: 403 });
    expect((await app.inventory.getProduct("BPC-10", read)).stock).toBe(3);

    await app.inventory.approveRestock(restock.id, admin);
    const received = await app.inventory.receiveRestock(restock.id, operator);
    expect(received.status).toBe("received");
    expect((await app.inventory.getProduct("BPC-10", read)).stock).toBe(23);
    await expect(app.inventory.receiveRestock(restock.id, admin)).rejects.toMatchObject({ code: "bad_transition" });
  });

  it("refuses a read-only key and keeps an audit trail", async () => {
    const { app } = shop();
    await expect(catalog(app, 5).then(() => app.orders.create({
      customer_email: "ada@helix.test",
      lines: [{ sku: "BPC-10", quantity: 1 }],
    }, read))).rejects.toMatchObject({ status: 403 });
    await catalog(app, 5);
    await app.orders.create({ customer_email: "ada@helix.test", lines: [{ sku: "BPC-10", quantity: 1 }] }, operator);
    const audit = await app.recentAudit(20, operator);
    expect(audit.entries.map((entry) => entry.action)).toContain("order.create");
    expect(audit.entries.find((entry) => entry.action === "order.create")).toMatchObject({ actor: "ops", role: "operator" });
    await expect(app.recentAudit(20, read)).rejects.toMatchObject({ status: 403 });
  });
});

describe("payment approval", () => {
  it("executes a charge and a refund only after admin approval, once each", async () => {
    const stripe = new MockStripe();
    const { app } = shop(stripe);
    await catalog(app, 5);
    const order = await app.orders.create(
      { customer_email: "ada@helix.test", lines: [{ sku: "BPC-10", quantity: 1 }] },
      operator,
    );

    const charge = await app.payments.requestCharge(
      { amount_cents: 4900, order_id: order.id, customer_email: "ada@helix.test", payment_method: "pm_testMethod", idempotency_key: "charge-helix-001", reason: "card on file" },
      operator,
    );
    expect(charge.status).toBe("pending");
    const replay = await app.payments.requestCharge(
      { amount_cents: 4900, order_id: order.id, payment_method: "pm_testMethod", idempotency_key: "charge-helix-001" },
      operator,
    );
    expect(replay.id).toBe(charge.id);
    await expect(app.payments.requestCharge(
      { amount_cents: 100, order_id: order.id, payment_method: "pm_testMethod", idempotency_key: "charge-helix-001" },
      operator,
    )).rejects.toMatchObject({ code: "idempotency_conflict" });

    await expect(app.payments.approve(charge.id, operator)).rejects.toMatchObject({ status: 403 });
    expect(stripe.charges).toHaveLength(0);

    const executed = await app.payments.approve(charge.id, admin);
    expect(executed.status).toBe("executed");
    expect(executed.provider_ref).toBe("pi_mock_1");
    expect(stripe.charges).toHaveLength(1);
    expect(stripe.charges[0]?.idempotencyKey).toBe("charge-helix-001");
    const again = await app.payments.approve(charge.id, admin);
    expect(again.provider_ref).toBe("pi_mock_1");
    expect(stripe.charges).toHaveLength(1);

    const pendingRefund = await app.payments.requestRefund(
      { charge_id: charge.id, amount_cents: 4900, idempotency_key: "refund-helix-001", reason: "unopened" },
      operator,
    );
    await app.payments.reject(pendingRefund.id, { reason: "wait for the return" }, admin);
    expect(stripe.refunds).toHaveLength(0);

    await expect(app.payments.requestRefund(
      { charge_id: charge.id, amount_cents: 5000, idempotency_key: "refund-helix-002" },
      operator,
    )).rejects.toMatchObject({ code: "too_much" });

    const refund = await app.payments.requestRefund(
      { charge_id: charge.id, idempotency_key: "refund-helix-003", reason: "returned" },
      operator,
    );
    expect(refund.amount_cents).toBe(4900);
    const refunded = await app.payments.approve(refund.id, admin);
    expect(refunded.status).toBe("executed");
    expect(stripe.refunds).toHaveLength(1);
    expect(stripe.refunds[0]?.paymentIntentId).toBe("pi_mock_1");
  });

  it("does not call Stripe when the secret is missing", async () => {
    const { app } = shop(null);
    await catalog(app, 2);
    const charge = await app.payments.requestCharge(
      { amount_cents: 1000, payment_method: "pm_testMethod", idempotency_key: "charge-no-stripe", currency: "usd" },
      operator,
    );
    await expect(app.payments.approve(charge.id, admin)).rejects.toMatchObject({ code: "stripe_not_configured" });
    expect((await app.payments.get(charge.id, read)).status).toBe("pending");
  });
});

describe("ask and ledger", () => {
  it("answers from orders and the knowledge store without inventing a model call", async () => {
    const { app } = shop();
    await catalog(app, 6);
    const order = await app.orders.create(
      { customer_email: "ada@helix.test", lines: [{ sku: "BPC-10", quantity: 1 }] },
      operator,
    );
    const record = await app.ledger.record(
      { kind: "policy", title: "Cold chain", body: "Ship BPC-157 with an ice pack.", ref_type: "product", ref_id: "BPC-10" },
      operator,
    );
    expect(record.item_id).toMatch(/^itm_/);

    const answer = await app.ask.ask("Where is the order for ada@helix.test and what is the cold chain policy?", read);
    expect(answer.model).toBe("local");
    expect(answer.answer).toContain(order.id);
    expect(answer.answer).toContain("ada@helix.test");
    expect(answer.briefing).toContain("Cold chain");
  });
});

describe("payment and inventory invariants", () => {
  it("preserves migrated payment IDs and reconciles old attempts with provider reads only", async () => {
    const oldPending = `pay_${"a".repeat(32)}`;
    const oldMissingMethod = `pay_${"b".repeat(32)}`;
    const oldExecuted = `pay_${"c".repeat(32)}`;
    const pendingInput = { amount_cents: 500, payment_method: "pm_testMethod", idempotency_key: "legacy-queue" };
    const hash = await sha256(JSON.stringify({
      kind: "charge", orderId: null, amount: 500, currency: "usd", paymentMethod: pendingInput.payment_method,
    }));
    const db = createDatabase(undefined, (fixture, version) => {
      if (version !== 4) return;
      const insert = fixture.prepare(
        `INSERT INTO payment_requests
           (id, kind, amount_cents, currency, idempotency_key, payload_hash, status, payment_method, provider_ref,
            requested_by, created_at, updated_at)
         VALUES (?, 'charge', 500, 'usd', ?, ?, ?, ?, ?, 'ops', '2026-01-01', '2026-01-01')`,
      );
      insert.run(oldPending, "legacy-queue", hash, "pending", "pm_testMethod", null);
      insert.run(oldMissingMethod, "legacy-missing", "old-hash", "pending", null, null);
      insert.run(oldExecuted, "legacy-executed", "old-hash", "executed", null, "pi_legacyCaptured");
    });
    const stripe = new MockStripe();
    stripe.payments.set("pi_legacyCaptured", {
      id: "pi_legacyCaptured", kind: "charge", amountCents: 500, settledCents: 500,
      requestId: oldExecuted, currency: "usd", status: "succeeded",
    });
    const app = new App(db, createBucket(), { clock: sequencedClock(), provider: stripe });
    expect(await app.payments.requestCharge(pendingInput, operator)).toMatchObject({ id: oldPending });
    await expect(app.payments.approve(oldPending, admin)).rejects.toMatchObject({ code: "reconciliation_required" });
    await expect(app.payments.approve(oldMissingMethod, admin)).rejects.toMatchObject({ code: "payment_method_required" });
    expect(await app.payments.reject(oldMissingMethod, {}, admin)).toMatchObject({ id: oldMissingMethod, status: "rejected" });
    expect(await app.payments.get(oldExecuted, read)).toMatchObject({ status: "executed", settled_cents: null });
    expect(await app.payments.approve(oldExecuted, admin)).toMatchObject({ id: oldExecuted, status: "executed", settled_cents: 500 });
    expect(stripe.charges).toHaveLength(0);
    expect(stripe.retrievals).toEqual(["pi_legacyCaptured"]);
  });

  it("marks an order paid only after enough verified money has arrived", async () => {
    const stripe = new MockStripe();
    const { app } = shop(stripe);
    await catalog(app);
    const order = await app.orders.create(
      { customer_email: "ada@helix.test", lines: [{ sku: "BPC-10", quantity: 1 }] }, operator,
    );
    await expect(app.orders.updateStatus(order.id, { status: "paid" }, operator))
      .rejects.toMatchObject({ code: "bad_transition" });
    const first = await app.payments.requestCharge({
      order_id: order.id, amount_cents: 2000, payment_method: "pm_testMethod", idempotency_key: "partial-first",
    }, operator);
    await app.payments.approve(first.id, admin);
    expect((await app.orders.get(order.id, read)).status).toBe("pending");
    const second = await app.payments.requestCharge({
      order_id: order.id, amount_cents: 2900, payment_method: "pm_testMethod", idempotency_key: "partial-second",
    }, operator);
    await app.payments.approve(second.id, admin);
    expect((await app.orders.get(order.id, read)).history.map((row) => row.to_status)).toEqual(["pending", "paid"]);
  });

  it("keeps a nonterminal charge reserved and later reconciles by reference", async () => {
    class ProcessingStripe extends MockStripe {
      override async charge(input: ChargeInput) {
        const payment = await super.charge(input);
        return { ...payment, status: "processing", settledCents: 0 };
      }
    }
    const stripe = new ProcessingStripe();
    let now = Date.parse("2026-01-01T00:00:00Z");
    const app = new App(createDatabase(), createBucket(), { clock: () => new Date(now).toISOString(), provider: stripe });
    await catalog(app);
    const order = await app.orders.create(
      { customer_email: "ada@helix.test", lines: [{ sku: "BPC-10", quantity: 1 }] }, operator,
    );
    const request = { order_id: order.id, amount_cents: 4900, payment_method: "pm_testMethod" };
    const payment = await app.payments.requestCharge({ ...request, idempotency_key: "processing-charge" }, operator);
    expect(await app.payments.approve(payment.id, admin)).toMatchObject({
      status: "needs_reconciliation", settled_cents: null, provider_ref: "pi_mock_1",
    });
    expect((await app.orders.get(order.id, read)).status).toBe("pending");
    await expect(app.payments.requestCharge({ ...request, idempotency_key: "processing-second" }, operator))
      .rejects.toMatchObject({ code: "too_much" });
    now += 24 * 60 * 60_000;
    expect(await app.payments.approve(payment.id, admin)).toMatchObject({ status: "executed", settled_cents: 4900 });
    expect(stripe.charges).toHaveLength(1);
    expect(stripe.retrievals).toEqual(["pi_mock_1"]);
  });

  it("reuses the original key after an ambiguous timeout and stops posting after the retry window", async () => {
    class LostResponseStripe extends MockStripe {
      override async charge(input: ChargeInput): Promise<ProviderPayment> {
        const prior = this.charges.findIndex((call) => call.idempotencyKey === input.idempotencyKey);
        if (prior !== -1) {
          this.charges.push(input);
          return this.retrieve("charge", `pi_mock_${prior + 1}`);
        }
        await super.charge(input);
        throw new Error("simulated timeout");
      }
    }
    const stripe = new LostResponseStripe();
    let now = Date.parse("2026-01-01T00:00:00Z");
    const app = new App(createDatabase(), createBucket(), { clock: () => new Date(now).toISOString(), provider: stripe });
    const request = { amount_cents: 500, payment_method: "pm_testMethod" };
    const first = await app.payments.requestCharge({ ...request, idempotency_key: "lost-first" }, operator);
    await expect(app.payments.approve(first.id, admin)).rejects.toMatchObject({ code: "stripe_error" });
    await expect(app.payments.approve(first.id, admin)).rejects.toMatchObject({ code: "payment_in_progress" });
    now += 61_000;
    expect((await app.payments.approve(first.id, admin)).status).toBe("executed");
    expect(stripe.charges.map(({ idempotencyKey }) => idempotencyKey)).toEqual(["lost-first", "lost-first"]);

    const expired = await app.payments.requestCharge({ ...request, idempotency_key: "lost-second" }, operator);
    await expect(app.payments.approve(expired.id, admin)).rejects.toMatchObject({ code: "stripe_error" });
    now += 23 * 60 * 60_000;
    await expect(app.payments.approve(expired.id, admin)).rejects.toMatchObject({ code: "reconciliation_required" });
    expect(stripe.charges).toHaveLength(3);
    await expect(app.payments.approve(expired.id, admin, "pi_mock_1")).rejects.toMatchObject({ code: "provider_mismatch" });
    expect((await app.payments.get(expired.id, read)).provider_ref).toBeNull();
    now += 61_000;
    expect((await app.payments.approve(expired.id, admin, "pi_mock_3")).status).toBe("executed");
    expect(stripe.charges).toHaveLength(3);
  });

  it("allows the current lease to finalize once when an older provider response arrives late", async () => {
    let signalEntered = () => {};
    let finishFirst = () => {};
    const entered = new Promise<void>((resolve) => { signalEntered = resolve; });
    const firstResponse = new Promise<void>((resolve) => { finishFirst = resolve; });
    class SlowStripe extends MockStripe {
      override async charge(input: ChargeInput): Promise<ProviderPayment> {
        if (this.charges.length > 0) {
          this.charges.push(input);
          return this.retrieve("charge", "pi_mock_1");
        }
        const payment = await super.charge(input);
        signalEntered();
        await firstResponse;
        return payment;
      }
    }
    const stripe = new SlowStripe();
    let now = Date.parse("2026-01-01T00:00:00Z");
    const app = new App(createDatabase(), createBucket(), { clock: () => new Date(now).toISOString(), provider: stripe });
    const charge = await app.payments.requestCharge({
      amount_cents: 500, payment_method: "pm_testMethod", idempotency_key: "lease-late-response",
    }, operator);
    const first = app.payments.approve(charge.id, admin);
    const staleResult = expect(first).rejects.toMatchObject({ code: "payment_in_progress" });
    try {
      await Promise.race([first, entered]);
      now += 61_000;
      expect(await app.payments.approve(charge.id, admin)).toMatchObject({ status: "executed", provider_ref: "pi_mock_1" });
    } finally {
      finishFirst();
      await staleResult;
    }
    expect(stripe.charges.map(({ idempotencyKey }) => idempotencyKey)).toEqual(["lease-late-response", "lease-late-response"]);
    expect((await app.recentAudit(20, operator)).entries.filter(({ action }) => action === "payment.execute")).toHaveLength(1);
  });

  it("caps charges against an order cumulatively, and frees the cap when a request is rejected", async () => {
    const { app } = shop(new MockStripe());
    await catalog(app, 5);
    const order = await app.orders.create(
      { customer_email: "ada@helix.test", lines: [{ sku: "BPC-10", quantity: 1 }] },
      operator,
    );
    const first = await app.payments.requestCharge(
      { amount_cents: 3000, order_id: order.id, payment_method: "pm_testMethod", idempotency_key: "charge-cap-001" },
      operator,
    );
    await expect(
      app.payments.requestCharge({ amount_cents: 2000, order_id: order.id, payment_method: "pm_testMethod", idempotency_key: "charge-cap-002" }, operator),
    ).rejects.toMatchObject({ code: "too_much" });

    await app.payments.reject(first.id, { reason: "wrong amount" }, admin);
    const second = await app.payments.requestCharge(
      { amount_cents: 2000, order_id: order.id, payment_method: "pm_testMethod", idempotency_key: "charge-cap-002" },
      operator,
    );
    expect(second.status).toBe("pending");
  });

  it("returns the same charge when a request is replayed with its idempotency key", async () => {
    const { app } = shop(new MockStripe());
    await catalog(app, 5);
    const order = await app.orders.create(
      { customer_email: "ada@helix.test", lines: [{ sku: "BPC-10", quantity: 1 }] },
      operator,
    );
    const request = { amount_cents: 4900, order_id: order.id, payment_method: "pm_testMethod", idempotency_key: "charge-replay-001" };
    const first = await app.payments.requestCharge(request, operator);
    const replay = await app.payments.requestCharge(request, operator);
    expect(replay.id).toBe(first.id);
  });

  it("refuses a charge on a cancelled order", async () => {
    const { app } = shop(new MockStripe());
    await catalog(app, 5);
    const order = await app.orders.create(
      { customer_email: "ada@helix.test", lines: [{ sku: "BPC-10", quantity: 1 }] },
      operator,
    );
    await app.orders.updateStatus(order.id, { status: "cancelled" }, operator);
    await expect(
      app.payments.requestCharge(
        { amount_cents: 100, order_id: order.id, payment_method: "pm_testMethod", idempotency_key: "charge-cancelled-001" },
        operator,
      ),
    ).rejects.toMatchObject({ code: "bad_transition" });
  });

  it("moves the order to paid when its charge executes", async () => {
    const { app } = shop(new MockStripe());
    await catalog(app, 5);
    const order = await app.orders.create(
      { customer_email: "ada@helix.test", lines: [{ sku: "BPC-10", quantity: 1 }] },
      operator,
    );
    const charge = await app.payments.requestCharge(
      { amount_cents: 4900, order_id: order.id, payment_method: "pm_testMethod", idempotency_key: "test0001" },
      operator,
    );
    await app.payments.approve(charge.id, admin);
    const paid = await app.orders.get(order.id, read);
    expect(paid.status).toBe("paid");
    expect(paid.history.map((event) => event.to_status)).toEqual(["pending", "paid"]);
  });


  it("rejects a second refund instead of failing with an internal error", async () => {
    const { app } = shop(new MockStripe());
    await catalog(app, 5);
    const order = await app.orders.create(
      { customer_email: "ada@helix.test", lines: [{ sku: "BPC-10", quantity: 1 }] },
      operator,
    );
    const charge = await app.payments.requestCharge(
      { amount_cents: 4900, order_id: order.id, payment_method: "pm_testMethod", idempotency_key: "test0002" },
      operator,
    );
    await app.payments.approve(charge.id, admin);
    const refund = await app.payments.requestRefund({ charge_id: charge.id, idempotency_key: "refund-all-001" }, operator);
    expect(refund.amount_cents).toBe(4900);
    await app.payments.approve(refund.id, admin);
    expect(await app.payments.requestRefund({ charge_id: charge.id, idempotency_key: "refund-all-001" }, operator))
      .toMatchObject({ id: refund.id, status: "executed" });
    await expect(
      app.payments.requestRefund({ charge_id: charge.id, idempotency_key: "refund-all-002" }, operator),
    ).rejects.toMatchObject({ code: "nothing_left", status: 409 });
  });

  it("receives a restock once even when the call is repeated", async () => {
    const { app } = shop();
    await catalog(app, 3);
    const restock = await app.inventory.createRestock(
      { supplier: "Lab supply", lines: [{ sku: "BPC-10", quantity: 20 }] },
      operator,
    );
    await app.inventory.approveRestock(restock.id, admin);
    await app.inventory.receiveRestock(restock.id, operator);
    expect((await app.inventory.getProduct("BPC-10", read)).stock).toBe(23);
    await expect(app.inventory.receiveRestock(restock.id, operator)).rejects.toMatchObject({ code: "bad_transition" });
    expect((await app.inventory.getProduct("BPC-10", read)).stock).toBe(23);
  });

  it("restores stock once when a cancel is repeated", async () => {
    const { app } = shop();
    await catalog(app, 10);
    const order = await app.orders.create(
      { customer_email: "ada@helix.test", lines: [{ sku: "BPC-10", quantity: 2 }] },
      operator,
    );
    await app.orders.updateStatus(order.id, { status: "cancelled" }, operator);
    expect((await app.inventory.getProduct("BPC-10", read)).stock).toBe(10);
    await expect(app.orders.updateStatus(order.id, { status: "cancelled" }, operator)).rejects.toMatchObject({
      code: "bad_transition",
    });
    expect((await app.inventory.getProduct("BPC-10", read)).stock).toBe(10);
  });

  it("keeps a charge retryable when Stripe succeeds but the record cannot be saved", async () => {
    const stripe = new MockStripe();
    let now = Date.parse("2026-01-01T00:00:00Z");
    const clock = () => new Date(now).toISOString();
    const db = createDatabase();
    const bucket = createBucket();
    const app = new App(db, bucket, { clock, provider: stripe });
    await catalog(app, 5);
    const order = await app.orders.create(
      { customer_email: "ada@helix.test", lines: [{ sku: "BPC-10", quantity: 1 }] },
      operator,
    );
    const charge = await app.payments.requestCharge(
      { amount_cents: 4900, order_id: order.id, payment_method: "pm_testMethod", idempotency_key: "charge-record-001" },
      operator,
    );
    const broken = new App(withFailingWrites(db, /INSERT INTO order_status_events/i), bucket, { clock, provider: stripe });
    await expect(broken.payments.approve(charge.id, admin)).rejects.toMatchObject({ code: "record_failed", status: 502 });
    expect(stripe.charges).toHaveLength(1);
    expect((await app.payments.get(charge.id, read)).status).toBe("needs_reconciliation");
    expect((await app.orders.get(order.id, read)).status).toBe("pending");
    now += 61_000;
    expect((await app.payments.approve(charge.id, admin)).status).toBe("executed");
    await app.payments.approve(charge.id, admin);
    expect(stripe.charges).toHaveLength(1);
    expect(stripe.retrievals).toEqual(["pi_mock_1"]);
    expect((await app.orders.get(order.id, read)).history.filter((event) => event.to_status === "paid")).toHaveLength(1);
    expect((await app.recentAudit(50, operator)).entries.filter((entry) => entry.action === "payment.execute")).toHaveLength(1);
  });
});

describe("transactional writes", () => {
  it("rolls back cancellation, restock receipt and stock adjustments when a dependent write fails", async () => {
    const db = createDatabase();
    const bucket = createBucket();
    const clock = sequencedClock();
    const app = new App(db, bucket, { clock });
    await catalog(app, 5);
    const order = await app.orders.create(
      { customer_email: "ada@helix.test", lines: [{ sku: "BPC-10", quantity: 2 }] }, operator,
    );
    const restock = await app.inventory.createRestock({ lines: [{ sku: "BPC-10", quantity: 4 }] }, operator);
    await app.inventory.approveRestock(restock.id, admin);
    const stockFault = new App(withFailingWrites(db, /INSERT INTO stock_adjustments/i), bucket, { clock });
    const auditFault = new App(withFailingWrites(db, /INSERT INTO audit_log/i), bucket, { clock });
    await expect(auditFault.orders.updateStatus(order.id, { status: "cancelled" }, operator)).rejects.toThrow();
    await expect(stockFault.inventory.receiveRestock(restock.id, operator)).rejects.toThrow();
    await expect(auditFault.inventory.adjust({ sku: "BPC-10", delta: 1, reason: "test" }, operator)).rejects.toThrow();
    expect((await app.orders.get(order.id, read)).history.map(({ to_status }) => to_status)).toEqual(["pending"]);
    expect((await app.orders.get(order.id, read)).status).toBe("pending");
    expect((await app.inventory.getRestock(restock.id, read)).status).toBe("approved");
    expect((await app.inventory.getProduct("BPC-10", read)).stock).toBe(3);
    await app.orders.updateStatus(order.id, { status: "cancelled" }, operator);
    await app.inventory.receiveRestock(restock.id, operator);
    expect((await app.inventory.getProduct("BPC-10", read)).stock).toBe(9);
  });

  it("commits no part of an order when a later statement fails", async () => {
    const db = createDatabase();
    const app = new App(withFailingWrites(db, /INSERT INTO order_lines/i), createBucket(), { clock: sequencedClock() });
    await catalog(app, 10);
    await app.inventory.upsertProduct(
      { sku: "TB-500", title: "TB-500 5mg", price_cents: 5500, stock: 4 },
      operator,
    );
    await expect(
      app.orders.create(
        {
          customer_email: "ada@helix.test",
          lines: [
            { sku: "BPC-10", quantity: 2 },
            { sku: "TB-500", quantity: 1 },
          ],
        },
        operator,
      ),
    ).rejects.toThrow();
    expect((await app.inventory.getProduct("BPC-10", read)).stock).toBe(10);
    expect((await app.inventory.getProduct("TB-500", read)).stock).toBe(4);
    const orders = await db.prepare(`SELECT COUNT(*) AS n FROM orders`).first<{ n: number }>();
    expect(Number(orders?.n)).toBe(0);
  });

  it("does not change stock when its adjustment cannot be written", async () => {
    const db = createDatabase();
    const app = new App(withFailingWrites(db, /INSERT INTO stock_adjustments/i), createBucket(), {
      clock: sequencedClock(),
    });
    await app.inventory.upsertProduct({ sku: "BPC-10", title: "BPC-157 10mg", price_cents: 4900 }, operator);
    await expect(app.inventory.adjust({ sku: "BPC-10", delta: 5, reason: "receiving" }, operator)).rejects.toThrow();
    expect((await app.inventory.getProduct("BPC-10", read)).stock).toBe(0);
  });
});

describe("admin queues and product patches", () => {
  it("preserves concurrent patches and never saves part of an invalid stock patch", async () => {
    const { app } = shop();
    await catalog(app, 5);
    await Promise.all([
      app.inventory.upsertProduct({ sku: "BPC-10", price_cents: 5200 }, operator),
      app.inventory.upsertProduct({ sku: "BPC-10", active: false }, operator),
    ]);
    await expect(app.inventory.upsertProduct({ sku: "BPC-10", title: "Invalid edit", stock: -1 }, operator))
      .rejects.toMatchObject({ code: "bad_amount" });
    expect(await app.inventory.getProduct("BPC-10", read))
      .toMatchObject({ title: "BPC-157 10mg", price_cents: 5200, active: false, stock: 5 });
  });

  it("lists the pending payments an admin needs to approve", async () => {
    const { app } = shop(new MockStripe());
    await catalog(app, 5);
    const order = await app.orders.create(
      { customer_email: "ada@helix.test", lines: [{ sku: "BPC-10", quantity: 1 }] },
      operator,
    );
    const first = await app.payments.requestCharge(
      { amount_cents: 1000, order_id: order.id, payment_method: "pm_testMethod", idempotency_key: "queue-001" },
      operator,
    );
    const second = await app.payments.requestCharge(
      { amount_cents: 1000, order_id: order.id, payment_method: "pm_testMethod", idempotency_key: "queue-002" },
      operator,
    );
    const pending = await app.payments.list({ status: "pending" }, read);
    expect(pending.payments.map((row) => row.id)).toEqual([second.id, first.id]);
    expect(pending.payments.every((row) => row.status === "pending")).toBe(true);
    expect(pending.next_cursor).toBeNull();
  });

  it("pages the payment queue with a cursor", async () => {
    const { app } = shop(new MockStripe());
    await catalog(app, 5);
    const order = await app.orders.create(
      { customer_email: "ada@helix.test", lines: [{ sku: "BPC-10", quantity: 1 }] },
      operator,
    );
    for (const key of ["page-001", "page-002", "page-003"]) {
      await app.payments.requestCharge({ amount_cents: 1000, order_id: order.id, payment_method: "pm_testMethod", idempotency_key: key }, operator);
    }
    const first = await app.payments.list({ limit: 2 }, read);
    expect(first.payments).toHaveLength(2);
    expect(first.next_cursor).toBeTruthy();
    const rest = await app.payments.list({ limit: 2, cursor: first.next_cursor }, read);
    expect(rest.payments).toHaveLength(1);
    expect(rest.next_cursor).toBeNull();
  });

  it("lists restock orders by status", async () => {
    const { app } = shop();
    await catalog(app, 3);
    const draft = await app.inventory.createRestock(
      { supplier: "Lab supply", lines: [{ sku: "BPC-10", quantity: 5 }] },
      operator,
    );
    const other = await app.inventory.createRestock(
      { supplier: "Backup lab", lines: [{ sku: "BPC-10", quantity: 6 }] },
      operator,
    );
    await app.inventory.approveRestock(other.id, admin);

    const drafts = await app.inventory.listRestocks({ status: "draft" }, read);
    expect(drafts.restocks.map((row) => row.id)).toEqual([draft.id]);
    const all = await app.inventory.listRestocks({}, read);
    expect(all.restocks.map((row) => row.id)).toEqual([other.id, draft.id]);
    expect(all.restocks.find((row) => row.id === other.id)?.status).toBe("approved");
  });

  it("patches a product without clearing fields the caller did not send", async () => {
    const { app } = shop();
    await catalog(app, 5);
    const deactivated = await app.inventory.upsertProduct({ sku: "BPC-10", active: false }, operator);
    expect(deactivated).toMatchObject({
      sku: "BPC-10",
      title: "BPC-157 10mg",
      price_cents: 4900,
      low_stock_threshold: 4,
      active: false,
      stock: 5,
    });

    const repriced = await app.inventory.upsertProduct({ sku: "BPC-10", price_cents: 5200 }, operator);
    expect(repriced).toMatchObject({ title: "BPC-157 10mg", price_cents: 5200, active: false, stock: 5 });
  });

  it("rejects an unknown product filter value", async () => {
    const { app } = shop();
    await expect(app.payments.list({ status: "settled" }, read)).rejects.toMatchObject({ status: 400 });
    await expect(app.inventory.listRestocks({ status: "open" }, read)).rejects.toMatchObject({ status: 400 });
  });
});


describe("Stripe adapter", () => {
  it("posts a payment intent and a refund with an idempotency key and no card number", async () => {
    const calls: { url: string; idempotency: string; body: string; authorization: string }[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      const headers = new Headers(init?.headers);
      calls.push({
        url: String(url),
        idempotency: headers.get("idempotency-key") ?? "",
        body: String(init?.body ?? ""),
        authorization: headers.get("authorization") ?? "",
      });
      const refund = String(url).endsWith("/refunds");
      return Response.json({
        id: refund ? "re_shape" : "pi_shape", object: refund ? "refund" : "payment_intent",
        status: "succeeded", amount: 1500, amount_received: 1500, currency: "usd",
        metadata: { request_id: refund ? "pay_refund" : "pay_test" }, payment_intent: refund ? "pi_shape" : undefined,
      });
    };
    const stripe = new StripeProvider("sk_test_example_not_real", fetchImpl);
    await stripe.charge({
      amountCents: 1500,
      currency: "usd",
      idempotencyKey: "charge-shape-001",
      description: "House of Helix Peptides",
      requestId: "pay_test",
      customerEmail: "ada@helix.test",
      paymentMethod: "pm_testMethod",
    });
    await stripe.refund({
      amountCents: 1500,
      idempotencyKey: "refund-shape-001",
      paymentIntentId: "pi_shape",
      requestId: "pay_refund",
      reason: "returned",
    });
    expect(calls[0]).toMatchObject({
      url: "https://api.stripe.com/v1/payment_intents",
      idempotency: "charge-shape-001",
      authorization: "Bearer sk_test_example_not_real",
    });
    expect(calls[0]?.body).toContain("amount=1500");
    expect(calls[0]?.body).toContain("confirm=true");
    expect(calls[0]?.body).not.toContain("4242");
    expect(calls[1]?.url).toBe("https://api.stripe.com/v1/refunds");
    expect(calls[1]?.body).toContain("payment_intent=pi_shape");
  });

  it("refuses a key that is not a Stripe secret", () => {
    expect(() => new StripeProvider("not-a-stripe-key")).toThrow(BankError);
  });
});
