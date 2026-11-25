// Runs inside workerd against local D1 and R2, so it covers what the node:sqlite
// suite cannot: D1's SQL engine (FTS5 triggers, json_each), the R2 binding, and
// the Worker's real module graph under nodejs_compat.
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { App } from "../../src/app.js";
import { r2BlobStore } from "../../src/blobs.js";
import type { SqlDatabase } from "../../src/env.js";
import { StripeProvider } from "../../src/stripe.js";

const OPERATOR = "dbk_test_workers_operator";
const READER = "dbk_test_workers_reader";
const ops = { bot: "ops", role: "operator" } as const;
const admin = { bot: "admin", role: "admin" } as const;
const paymentMethod = "pm_testMethod";

function call(path: string, init: RequestInit & { token?: string } = {}) {
  const { token, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (rest.body) headers.set("content-type", "application/json");
  return exports.default.fetch(new Request(`http://data-bank.local${path}`, { ...rest, headers }));
}

async function rpc(method: string, params: unknown, token = OPERATOR) {
  const response = await call("/mcp", {
    method: "POST",
    token,
    headers: { accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { result?: { content?: { text: string }[]; isError?: boolean } };
  return body.result;
}

async function tool<T>(name: string, args: Record<string, unknown>, token = OPERATOR): Promise<T> {
  const result = await rpc("tools/call", { name, arguments: args }, token);
  expect(result?.isError ?? false).toBe(false);
  return JSON.parse(result?.content?.[0]?.text ?? "null") as T;
}

describe("worker in workerd", () => {
  it("serves health without a token and rejects a wrong one", async () => {
    const health = await call("/health?deep=1");
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, service: "data-bank", checks: { d1: "ok", r2: "ok" } });

    expect((await call("/v1/whoami", { token: "dbk_not_a_real_token_at_all" })).status).toBe(401);
    expect(await (await call("/v1/whoami", { token: READER })).json()).toEqual({ bot: "reader-bot", role: "read" });
  });

  it("indexes saved items through the D1 FTS5 triggers and filters tags with json_each", async () => {
    const saved = await tool<{ id: string; author: string }>("save_item", {
      title: "Cold chain checklist",
      content: "Ship lyophilized vials with ice packs between October and March.",
      tags: ["shipping", "cold-chain"],
      collection: "ops",
    });
    expect(saved.author).toBe("local-bot");
    await tool("save_item", {
      title: "Unrelated",
      content: "Lyophilized vials are stored dry.",
      tags: ["storage"],
      collection: "ops",
    });

    const keyword = await tool<{ items: { id: string }[] }>(
      "search_items",
      { query: "ice packs", mode: "keyword", collection: "ops" },
      READER,
    );
    expect(keyword.items.map((item) => item.id)).toEqual([saved.id]);

    const tagged = await tool<{ items: { id: string }[] }>(
      "search_items",
      { query: "lyophilized vials", mode: "keyword", tags: ["cold-chain"] },
      READER,
    );
    expect(tagged.items.map((item) => item.id)).toEqual([saved.id]);

    // The update trigger must drop the old text from the index. Terms are OR-ed, so search a word only the old text had.
    await tool("update_item", { id: saved.id, content: "Ship with dry ice instead." });
    const stale = await tool<{ items: unknown[] }>("search_items", { query: "packs", mode: "keyword" }, READER);
    expect(stale.items).toHaveLength(0);
    const fresh = await tool<{ items: { id: string }[] }>(
      "search_items",
      { query: "instead", mode: "keyword" },
      READER,
    );
    expect(fresh.items.map((item) => item.id)).toEqual([saved.id]);
  });

  it("stores bodies over 64 KiB in R2 and deletes them with the item", async () => {
    const content = `${"peptide stability data ".repeat(3500)}end-marker`;
    expect(content.length).toBeGreaterThan(64 * 1024);

    const created = await call("/v1/items", {
      method: "POST",
      token: OPERATOR,
      body: JSON.stringify({ title: "Stability report", content, type: "doc" }),
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };

    const object = await env.BUCKET.get(`items/${id}`);
    expect(await object?.text()).toBe(content);

    const fetched = (await (await call(`/v1/items/${id}`, { token: READER })).json()) as { content: string };
    expect(fetched.content).toBe(content);

    expect((await call(`/v1/items/${id}`, { method: "DELETE", token: OPERATOR })).status).toBe(200);
    expect(await env.BUCKET.get(`items/${id}`)).toBeNull();
  });

  it("reserves stock on order, refuses to oversell, and restores stock on cancel", async () => {
    const product = await call("/v1/products", {
      method: "POST",
      token: OPERATOR,
      body: JSON.stringify({
        sku: "TB-500-5",
        title: "TB-500 5mg",
        price_cents: 5500,
        stock: 6,
        low_stock_threshold: 2,
      }),
    });
    expect(product.status).toBe(201);

    const order = await call("/v1/orders", {
      method: "POST",
      token: OPERATOR,
      body: JSON.stringify({ customer_email: "grace@helix.test", lines: [{ sku: "TB-500-5", quantity: 4 }] }),
    });
    expect(order.status).toBe(201);
    const { id, total_cents } = (await order.json()) as { id: string; total_cents: number };
    expect(total_cents).toBe(22_000);

    const stock = async () =>
      ((await (await call("/v1/products/TB-500-5", { token: READER })).json()) as { stock: number }).stock;
    expect(await stock()).toBe(2);

    const oversell = await call("/v1/orders", {
      method: "POST",
      token: OPERATOR,
      body: JSON.stringify({ customer_email: "grace@helix.test", lines: [{ sku: "TB-500-5", quantity: 3 }] }),
    });
    expect(oversell.status).toBe(409);
    expect(await stock()).toBe(2);

    const cancelled = await call(`/v1/orders/${id}`, {
      method: "PATCH",
      token: OPERATOR,
      body: JSON.stringify({ status: "cancelled" }),
    });
    expect(cancelled.status).toBe(200);
    expect(await stock()).toBe(6);
  });

  it("serializes overlapping charge, refund, and same-key reservations in D1", async () => {
    const stripe = stripeStub();
    const app = shop(stripe);
    const order = await makeOrder(app, "D1-CAP");
    const charge = { amount_cents: 3000, order_id: order.id, payment_method: paymentMethod };
    const race = shop(stripe, overlapBatches());
    const overlapping = await Promise.allSettled(["workers-cap-one", "workers-cap-two"].map((idempotency_key) =>
      race.payments.requestCharge({ ...charge, idempotency_key }, ops),
    ));
    expect(overlapping.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(overlapping.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "too_much" } });
    const pending = await app.payments.list({ order_id: order.id, status: "pending" }, ops);
    expect(pending.payments).toHaveLength(1);
    const payment = pending.payments[0];
    if (!payment) throw new Error("Expected one charge reservation.");
    await app.payments.approve(payment.id, admin);

    const refundRace = shop(stripe, overlapBatches());
    const refunds = await Promise.allSettled(["workers-refund-one", "workers-refund-two"].map((idempotency_key) =>
      refundRace.payments.requestRefund({ charge_id: payment.id, amount_cents: 2000, idempotency_key }, ops),
    ));
    expect(refunds.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(refunds.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "too_much" } });

    const duplicateRace = shop(stripe, overlapBatches());
    const request = { amount_cents: 1000, payment_method: paymentMethod, idempotency_key: "workers-same-key" };
    const [first, second] = await Promise.all([
      duplicateRace.payments.requestCharge(request, ops),
      duplicateRace.payments.requestCharge(request, ops),
    ]);
    expect(first.id).toBe(second.id);
    const audit = await env.DB.prepare("SELECT count(*) AS n FROM audit_log WHERE action = 'payment.request' AND entity_id = ?")
      .bind(first.id).first<{ n: number }>();
    expect(audit?.n).toBe(1);
  });

  it("claims an approval before Stripe, preventing a competing approval, rejection, or cancellation", async () => {
    const entered = gate();
    const finish = gate();
    const stripe = stripeStub(async () => {
      entered.resolve();
      await finish.promise;
    });
    const app = shop(stripe);
    const order = await makeOrder(app, "D1-CLAIM");
    const charge = await app.payments.requestCharge({
      order_id: order.id, amount_cents: 5000, payment_method: paymentMethod, idempotency_key: "workers-claim",
    }, ops);
    const approving = app.payments.approve(charge.id, admin);
    try {
      await Promise.race([entered.promise, approving]);
      await expect(app.payments.approve(charge.id, admin)).rejects.toMatchObject({ code: "payment_in_progress" });
      await expect(app.payments.reject(charge.id, {}, admin)).rejects.toMatchObject({ code: "bad_transition" });
      await expect(app.orders.updateStatus(order.id, { status: "cancelled" }, ops)).rejects.toMatchObject({ code: "bad_transition" });
      const { stock } = await app.inventory.getProduct("D1-CLAIM", ops);
      expect(stock).toBe(4);
    } finally {
      finish.resolve();
      await approving;
    }
    expect((await app.orders.get(order.id, ops)).history.map((row) => row.to_status)).toEqual(["pending", "paid"]);
    const cancelledFirst = await makeOrder(app, "D1-CANCEL-FIRST");
    const queued = await app.payments.requestCharge({
      order_id: cancelledFirst.id, amount_cents: 5000, payment_method: paymentMethod, idempotency_key: "workers-cancel-first",
    }, ops);
    await app.orders.updateStatus(cancelledFirst.id, { status: "cancelled" }, ops);
    await expect(app.payments.approve(queued.id, admin)).rejects.toMatchObject({ code: "bad_transition" });
  });

  it("uses queue indexes and serves tied timestamps without duplicate restocks", async () => {
    for (const [sql, index] of [
      ["SELECT * FROM payment_requests WHERE status = 'pending' ORDER BY created_at DESC, id DESC LIMIT 10", "idx_payments_status"],
      ["SELECT * FROM restock_orders WHERE status = 'draft' ORDER BY created_at DESC, id DESC LIMIT 10", "idx_restocks_status"],
      ["SELECT * FROM orders ORDER BY created_at DESC, id DESC LIMIT 10", "idx_orders_created"],
    ] as const) {
      const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).all<{ detail: string }>();
      expect(results.map(({ detail }) => detail).join("\n")).toContain(index);
      expect(results.some(({ detail }) => detail.includes("TEMP B-TREE"))).toBe(false);
    }
    const app = new App(env.DB, r2BlobStore(env.BUCKET), { clock: () => "2040-01-01T00:00:00.000Z" });
    await app.inventory.upsertProduct({ sku: "D1-QUEUE", title: "Synthetic stock" }, ops);
    const restocks = [];
    for (let index = 0; index < 3; index++) {
      restocks.push(await app.inventory.createRestock({ lines: [{ sku: "D1-QUEUE", quantity: 1 }] }, ops));
    }
    const first = await app.inventory.listRestocks({ status: "draft", limit: 2 }, ops);
    const next = await app.inventory.listRestocks({ status: "draft", limit: 2, cursor: first.next_cursor }, ops);
    expect([...first.restocks, ...next.restocks].slice(0, 3).map(({ id }) => id)).toEqual(restocks.map(({ id }) => id).sort().reverse());
  });

  it("receives a restock once across concurrent D1 transactions", async () => {
    const app = new App(env.DB, r2BlobStore(env.BUCKET));
    await app.inventory.upsertProduct({ sku: "D1-RESTOCK", title: "Synthetic stock", stock: 1 }, ops);
    const restock = await app.inventory.createRestock({ lines: [{ sku: "D1-RESTOCK", quantity: 2 }] }, ops);
    await app.inventory.approveRestock(restock.id, admin);
    const race = new App(overlapBatches(), r2BlobStore(env.BUCKET));
    const receipts = await Promise.allSettled([
      race.inventory.receiveRestock(restock.id, ops),
      race.inventory.receiveRestock(restock.id, ops),
    ]);
    expect(receipts.map(({ status }) => status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(await app.inventory.getProduct("D1-RESTOCK", ops)).toMatchObject({ stock: 3 });
    const audit = await env.DB.prepare("SELECT count(*) AS n FROM audit_log WHERE action = 'restock.receive' AND entity_id = ?")
      .bind(restock.id).first<{ n: number }>();
    expect(audit?.n).toBe(1);
  });
});

function shop(provider: StripeProvider, db: SqlDatabase = env.DB) {
  return new App(db, r2BlobStore(env.BUCKET), { provider });
}

async function makeOrder(app: App, sku: string) {
  await app.inventory.upsertProduct({ sku, title: "Synthetic stock", stock: 5, price_cents: 5000 }, ops);
  return app.orders.create({ customer_email: "ops@helix.test", lines: [{ sku, quantity: 1 }] }, ops);
}

function overlapBatches(): SqlDatabase {
  const entered = gate();
  let arrivals = 0;
  return {
    prepare: (sql) => env.DB.prepare(sql),
    async batch(statements) {
      if (++arrivals === 2) entered.resolve();
      await entered.promise;
      return env.DB.batch(statements as D1PreparedStatement[]);
    },
  };
}

function gate() {
  let open = () => {};
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, resolve: open };
}

function stripeStub(beforeRespond?: () => Promise<void>) {
  return new StripeProvider("sk_test_example_not_real", async (url, init) => {
    const body = new URLSearchParams(String(init.body));
    const refund = url.endsWith("/refunds");
    const requestId = body.get("metadata[request_id]");
    const amount = Number(body.get("amount"));
    await beforeRespond?.();
    return Response.json({
      id: `${refund ? "re" : "pi"}_${requestId}`,
      object: refund ? "refund" : "payment_intent",
      status: "succeeded",
      amount,
      amount_received: amount,
      currency: "usd",
      metadata: { request_id: requestId },
      payment_intent: body.get("payment_intent"),
    });
  });
}
