import { describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import { createDatabase, createEnv, LOCAL_KEY, SECOND_KEY } from "./helpers.js";

const env = () => createEnv();

function call(target: EnvTarget, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  return worker.fetch(new Request(`http://data-bank.local${path}`, { ...init, headers }), target);
}

type EnvTarget = ReturnType<typeof env>;

async function rpc(target: EnvTarget, method: string, params?: unknown, id = 1, token = LOCAL_KEY) {
  const response = await call(target, "/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  return { status: response.status, body: await response.json() as JsonRpc };
}

interface JsonRpc {
  result?: {
    protocolVersion?: string;
    serverInfo?: { name: string };
    tools?: { name: string }[];
    content?: { type: string; text: string }[];
    isError?: boolean;
  };
  error?: { message: string };
}

describe("HTTP", () => {
  it("serves health and the service index without a token", async () => {
    const target = env();
    const health = await call(target, "/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, service: "data-bank" });

    const root = await call(target, "/");
    expect(root.status).toBe(200);
    expect(await root.json()).toMatchObject({ mcp: "/mcp" });
  });

  it("rejects missing and wrong tokens", async () => {
    const target = env();
    const missing = await call(target, "/v1/whoami");
    expect(missing.status).toBe(401);

    const wrong = await call(target, "/v1/whoami", { headers: { authorization: "Bearer dbk_not_a_real_token" } });
    expect(wrong.status).toBe(401);

    const ok = await call(target, "/v1/whoami", { headers: { authorization: `Bearer ${SECOND_KEY}` } });
    expect(await ok.json()).toEqual({ bot: "second-bot", role: "operator" });
  });

  it("lists MCP tools and round-trips a save and a search", async () => {
    const target = env();
    const initialized = await rpc(target, "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test", version: "0.0.0" },
    });
    expect(initialized.status).toBe(200);
    expect(initialized.body.result?.serverInfo?.name).toBe("data-bank");
    expect(initialized.body.result?.protocolVersion).toBe("2025-11-25");

    const listed = await rpc(target, "tools/list", {}, 2);
    const names = listed.body.result?.tools?.map((tool) => tool.name).sort();
    expect(names).toEqual([
      "adjust_stock",
      "approve_restock_order",
      "approve_transaction",
      "ask",
      "cancel_restock_order",
      "create_collection",
      "create_order",
      "create_restock_order",
      "delete_collection",
      "delete_item",
      "get_item",
      "get_order",
      "get_product",
      "get_restock_order",
      "get_transaction",
      "list_audit",
      "list_business_records",
      "list_collections",
      "list_items",
      "list_orders",
      "list_payments",
      "list_products",
      "list_restocks",
      "lookup_orders",
      "low_stock_report",
      "receive_restock_order",
      "record_business_event",
      "reject_transaction",
      "request_charge",
      "request_refund",
      "save_item",
      "search_items",
      "update_item",
      "update_order_status",
      "upsert_product",
      "whoami",
    ]);

    const saved = await rpc(target, "tools/call", {
      name: "save_item",
      arguments: {
        title: "Shared note",
        content: "Grok bots keep the release checklist in the data bank.",
        tags: ["release"],
        collection: "bots",
      },
    }, 3);
    const created = JSON.parse(saved.body.result?.content?.[0]?.text ?? "{}") as { id: string; author: string };
    expect(created.author).toBe("local-bot");
    expect(created.id).toMatch(/^itm_/);

    const found = await rpc(target, "tools/call", {
      name: "search_items",
      arguments: { query: "release checklist", mode: "hybrid", collection: "bots" },
    }, 4);
    const hits = JSON.parse(found.body.result?.content?.[0]?.text ?? "{}") as { items: { title: string }[] };
    expect(hits.items.map((item) => item.title)).toContain("Shared note");
  });

  it("mirrors the write on the REST API and attributes the second bot", async () => {
    const target = env();
    const created = await call(target, "/v1/items", {
      method: "POST",
      headers: {
        authorization: `Bearer ${SECOND_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ title: "From REST", content: "Script wrote this datapoint.", type: "note" }),
    });
    expect(created.status).toBe(201);
    const item = await created.json() as { id: string; author: string };
    expect(item.author).toBe("second-bot");

    const searched = await call(target, "/v1/search", {
      method: "POST",
      headers: {
        authorization: `Bearer ${LOCAL_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ query: "datapoint", mode: "keyword" }),
    });
    const body = await searched.json() as { items: { id: string }[] };
    expect(body.items.map((hit) => hit.id)).toContain(item.id);

    const removed = await call(target, `/v1/items/${item.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${LOCAL_KEY}` },
    });
    expect(removed.status).toBe(200);
  });

  it("patches a product without clearing the fields the caller did not send", async () => {
    const target = env();
    const auth = { authorization: `Bearer ${LOCAL_KEY}`, "content-type": "application/json" };
    const created = await call(target, "/v1/products", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        sku: "PATCH-1",
        title: "Patch test",
        description: "kept",
        price_cents: 4900,
        low_stock_threshold: 4,
        stock: 2,
      }),
    });
    expect(created.status).toBe(201);

    const patched = await call(target, "/v1/products/PATCH-1", {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({ active: false }),
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({
      sku: "PATCH-1",
      title: "Patch test",
      description: "kept",
      price_cents: 4900,
      low_stock_threshold: 4,
      stock: 2,
      active: false,
    });
  });

  it("returns 400 for a malformed path segment instead of 500", async () => {
    const target = env();
    const response = await call(target, "/v1/items/%E0%A4%A", {
      headers: { authorization: `Bearer ${LOCAL_KEY}` },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "bad_path" });
  });

  it("reports dependency health only when the schema and bucket respond", async () => {
    const target = env();
    const healthy = await call(target, "/health?deep=1");
    expect(healthy.status).toBe(200);
    expect(await healthy.json()).toMatchObject({ ok: true, checks: { d1: "ok", r2: "ok" } });

    const broken = {
      ...target,
      BUCKET: {
        put: async () => undefined,
        get: async () => {
          throw new Error("bucket unavailable");
        },
        delete: async () => undefined,
      },
    };
    const unhealthy = await call(broken, "/health?deep=1");
    expect(unhealthy.status).toBe(503);
    expect(await unhealthy.json()).toMatchObject({ ok: false, checks: { d1: "ok", r2: "error" } });

    for (const DB of [createDatabase(2), createDatabase(3)]) {
      const oldSchema = await call({ ...target, DB }, "/health?deep=1");
      expect(oldSchema.status).toBe(503);
      expect(await oldSchema.json()).toMatchObject({ ok: false, checks: { d1: "error", r2: "ok" } });
    }

    // The bindings can be absent at runtime when a deployment is misconfigured.
    const withoutBindings = await call({ API_KEYS: target.API_KEYS } as EnvTarget, "/health?deep=1");
    expect(withoutBindings.status).toBe(503);
    expect(await withoutBindings.json()).toMatchObject({ ok: false, checks: { d1: "error", r2: "error" } });
  });

  it("exposes the pending payment queue over REST", async () => {
    const target = env();
    const auth = { authorization: `Bearer ${LOCAL_KEY}`, "content-type": "application/json" };
    await call(target, "/v1/products", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ sku: "QUEUE-1", title: "Queue test", price_cents: 2500, stock: 5 }),
    });
    const ordered = await call(target, "/v1/orders", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ customer_email: "ada@helix.test", lines: [{ sku: "QUEUE-1", quantity: 1 }] }),
    });
    const order = (await ordered.json()) as { id: string };
    const charged = await call(target, "/v1/payments/charges", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ amount_cents: 2500, order_id: order.id, payment_method: "pm_testMethod", idempotency_key: "queue-rest-001" }),
    });
    expect(charged.status).toBe(201);
    const charge = (await charged.json()) as { id: string };

    const queue = await call(target, "/v1/payments?status=pending", {
      headers: { authorization: `Bearer ${LOCAL_KEY}` },
    });
    expect(queue.status).toBe(200);
    const body = (await queue.json()) as { payments: { id: string; status: string }[] };
    expect(body.payments.map((row) => row.id)).toEqual([charge.id]);
    expect(body.payments[0]?.status).toBe("pending");
  });

  it("times out a stalled readiness dependency", async () => {
    const target = env();
    const stalled = {
      ...target,
      BUCKET: { put: async () => undefined, get: () => new Promise<null>(() => {}), delete: async () => undefined },
    };
    vi.useFakeTimers();
    try {
      const response = call(stalled, "/health?deep=1");
      await vi.advanceTimersByTimeAsync(2000);
      expect((await response).status).toBe(503);
      expect(await (await response).json()).toMatchObject({ checks: { d1: "ok", r2: "error" } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("requires a Stripe payment method through REST and MCP", async () => {
    const target = env();
    const input = { amount_cents: 500, idempotency_key: "required-method" };
    const rest = await call(target, "/v1/payments/charges", {
      method: "POST",
      headers: { authorization: `Bearer ${LOCAL_KEY}` },
      body: JSON.stringify(input),
    });
    expect(rest.status).toBe(400);
    expect(await rest.json()).toMatchObject({ code: "payment_method_required" });
    const mcp = await rpc(target, "tools/call", { name: "request_charge", arguments: input });
    expect(mcp.body.result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("payment_method") }] });
  });
});
