import { App } from "./app.js";
import { AuthFailure, authenticate, type Actor } from "./auth.js";
import { ExtractiveModel, WorkersAiModel } from "./ask.js";
import { r2BlobStore } from "./blobs.js";
import type { Env } from "./env.js";
import { ConfigError } from "./errors.js";
import { empty, errorResponse, json, withCors } from "./http.js";
import { handleMcp } from "./mcp.js";
import { handleRest } from "./rest.js";
import { StripeProvider, type PaymentProvider } from "./stripe.js";

const SERVICE = {
  service: "data-bank",
  business: "House of Helix Peptides",
  version: "0.2.0",
  mcp: "/mcp",
  health: "/health",
  auth: "Authorization: Bearer <token>",
  roles: ["read", "operator", "admin"],
  rest: {
    whoami: "GET /v1/whoami",
    collections: "GET|POST /v1/collections",
    collection: "DELETE /v1/collections/:name",
    items: "GET|POST /v1/items",
    search: "POST /v1/search",
    orders: "GET|POST /v1/orders",
    order: "GET|PATCH /v1/orders/:id",
    products: "GET|POST /v1/products",
    product: "GET|PATCH /v1/products/:sku",
    adjustments: "POST /v1/products/:sku/adjustments",
    restocks: "GET|POST /v1/restocks",
    restock: "GET /v1/restocks/:id",
    charges: "POST /v1/payments/charges",
    refunds: "POST /v1/payments/refunds",
    payments: "GET /v1/payments",
    payment: "GET /v1/payments/:id",
    approve: "POST /v1/payments/:id/approve",
    reject: "POST /v1/payments/:id/reject",
    ledger: "GET|POST /v1/ledger",
    ask: "POST /v1/ask",
    audit: "GET /v1/audit",
    healthDeep: "GET /health?deep=1",
  },
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const started = Date.now();
    const requestId = crypto.randomUUID();
    let status = 500;
    let bot: string | undefined;
    try {
      const response = await route(request, env, path, (actor) => {
        bot = actor.bot;
      });
      status = response.status;
      return withCors(response);
    } catch (error) {
      const response = errorResponse(error);
      status = response.status;
      return withCors(response);
    } finally {
      console.log(
        JSON.stringify({
          request_id: requestId,
          method: request.method,
          path,
          status,
          bot,
          duration_ms: Date.now() - started,
        }),
      );
    }
  },
};

async function route(
  request: Request,
  env: Env,
  path: string,
  seen: (actor: Actor) => void,
): Promise<Response> {
  if (request.method === "OPTIONS") return empty(204);

  if (request.method === "GET" && path === "/health") {
    const url = new URL(request.url);
    const deep = url.searchParams.get("deep");
    if (deep === "1" || deep === "true") return deepHealth(env);
    return json({ ok: true, service: "data-bank" });
  }
  if (request.method === "GET" && path === "/") {
    return json(SERVICE);
  }

  if (path !== "/mcp" && !path.startsWith("/v1")) {
    return json({ error: "Not found", code: "not_found" }, 404);
  }

  let actor: Actor;
  try {
    actor = authenticate(
      request.headers.get("authorization"),
      request.headers.get("x-api-key"),
      env.API_KEYS,
    );
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      return json({ error: "API_KEYS is not configured correctly.", code: "not_configured" }, 503);
    }
    if (error instanceof AuthFailure) {
      return json({ error: "Unauthorized", code: "unauthorized" }, 401, {
        "www-authenticate": 'Bearer realm="data-bank"',
      });
    }
    throw error;
  }
  seen(actor);

  let provider: PaymentProvider | null = null;
  if (env.STRIPE_SECRET_KEY) {
    try {
      provider = new StripeProvider(env.STRIPE_SECRET_KEY);
    } catch (error) {
      console.error(error instanceof Error ? error.message : "Stripe is not configured.");
    }
  }
  const app = new App(env.DB, r2BlobStore(env.BUCKET), {
    provider,
    model: env.AI && env.ANSWERER !== "local" ? new WorkersAiModel(env.AI) : new ExtractiveModel(),
  });
  if (path === "/mcp") return handleMcp(request, app, actor);
  return handleRest(request, app, actor);
}

/**
 * Proves the bindings actually work, not just that the Worker started. A missing migration or an
 * unbound bucket turns the deploy health check red instead of reporting healthy while every
 * request fails.
 */
async function deepHealth(env: Env): Promise<Response> {
  const [schema, bucket] = await Promise.allSettled([
    withTimeout(() =>
      env.DB.prepare(
        `SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN
           ('items', 'items_fts', 'orders', 'payment_requests', 'audit_log', 'restock_orders',
            'idx_orders_created', 'idx_payments_created', 'idx_restocks_created', 'idx_payments_charge')
         AND NOT EXISTS (
           SELECT 1 FROM payment_requests
           WHERE 0 AND COALESCE(first_attempt_at, attempt_id, lease_until, legacy_request, settled_cents) IS NULL
         )`,
      ).first<{ n: number }>(),
    ),
    withTimeout(() => env.BUCKET.get("healthcheck/probe")),
  ]);
  const d1 = schema.status === "fulfilled" && Number(schema.value?.n ?? 0) === 10 ? "ok" : "error";
  const r2 = bucket.status === "fulfilled" ? "ok" : "error";
  const ok = d1 === "ok" && r2 === "ok";
  return json({ ok, service: "data-bank", checks: { d1, r2 } }, ok ? 200 : 503);
}

async function withTimeout<T>(operation: () => Promise<T>, ms = 2000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("timed out")), ms); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
