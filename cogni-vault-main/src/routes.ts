import type { Actor } from "./auth.js";
import type { App } from "./app.js";
import { objectBody } from "./fields.js";
import { decodeSegment, json, readJson } from "./http.js";

export async function handleBusiness(request: Request, app: App, actor: Actor, path: string): Promise<Response | null> {
  const url = new URL(request.url);
  const method = request.method;

  if (path === "/v1/orders") {
    if (method === "GET") {
      return json(await app.orders.lookup({
        email: url.searchParams.get("email"),
        status: url.searchParams.get("status"),
        limit: url.searchParams.get("limit"),
      }, actor));
    }
    if (method === "POST") return json(await app.orders.create(await readJson(request), actor), 201);
    return methodNotAllowed("GET, POST");
  }

  const orderMatch = /^\/v1\/orders\/([^/]+)$/.exec(path);
  if (orderMatch) {
    const id = decodeSegment(orderMatch[1] ?? "");
    if (method === "GET") return json(await app.orders.get(id, actor));
    if (method === "PATCH") return json(await app.orders.updateStatus(id, await readJson(request), actor));
    return methodNotAllowed("GET, PATCH");
  }

  if (path === "/v1/products") {
    if (method === "GET") {
      return json(await app.inventory.listProducts(url.searchParams.get("low_stock") === "true", actor));
    }
    if (method === "POST") return json(await app.inventory.upsertProduct(await readJson(request), actor), 201);
    return methodNotAllowed("GET, POST");
  }

  const productMatch = /^\/v1\/products\/([^/]+)$/.exec(path);
  if (productMatch) {
    const sku = decodeSegment(productMatch[1] ?? "");
    if (method === "GET") return json(await app.inventory.getProduct(sku, actor));
    if (method === "PATCH") return json(await app.inventory.upsertProduct({ ...objectBody(await readJson(request)), sku }, actor));
    return methodNotAllowed("GET, PATCH");
  }

  const adjustMatch = /^\/v1\/products\/([^/]+)\/adjustments$/.exec(path);
  if (adjustMatch) {
    if (method !== "POST") return methodNotAllowed("POST");
    const sku = decodeSegment(adjustMatch[1] ?? "");
    return json(await app.inventory.adjust({ ...objectBody(await readJson(request)), sku }, actor), 201);
  }

  if (path === "/v1/restocks") {
    if (method === "GET") {
      return json(
        await app.inventory.listRestocks(
          {
            status: url.searchParams.get("status"),
            limit: url.searchParams.get("limit"),
            cursor: url.searchParams.get("cursor"),
          },
          actor,
        ),
      );
    }
    if (method === "POST") return json(await app.inventory.createRestock(await readJson(request), actor), 201);
    return methodNotAllowed("GET, POST");
  }

  const restockMatch = /^\/v1\/restocks\/([^/]+)(?:\/(approve|receive|cancel))?$/.exec(path);
  if (restockMatch) {
    const id = decodeSegment(restockMatch[1] ?? "");
    const action = restockMatch[2];
    if (!action && method === "GET") return json(await app.inventory.getRestock(id, actor));
    if (action === "approve" && method === "POST") return json(await app.inventory.approveRestock(id, actor));
    if (action === "receive" && method === "POST") return json(await app.inventory.receiveRestock(id, actor));
    if (action === "cancel" && method === "POST") return json(await app.inventory.cancelRestock(id, actor));
    return methodNotAllowed(action ? "POST" : "GET");
  }

  if (path === "/v1/payments/charges") {
    if (method !== "POST") return methodNotAllowed("POST");
    return json(await app.payments.requestCharge(await readJson(request), actor), 201);
  }
  if (path === "/v1/payments/refunds") {
    if (method !== "POST") return methodNotAllowed("POST");
    return json(await app.payments.requestRefund(await readJson(request), actor), 201);
  }

  if (path === "/v1/payments") {
    if (method !== "GET") return methodNotAllowed("GET");
    return json(
      await app.payments.list(
        {
          status: url.searchParams.get("status"),
          kind: url.searchParams.get("kind"),
          order_id: url.searchParams.get("order_id"),
          limit: url.searchParams.get("limit"),
          cursor: url.searchParams.get("cursor"),
        },
        actor,
      ),
    );
  }

  const paymentMatch = /^\/v1\/payments\/([^/]+)(?:\/(approve|reject))?$/.exec(path);
  if (paymentMatch && paymentMatch[1] !== "charges" && paymentMatch[1] !== "refunds") {
    const id = decodeSegment(paymentMatch[1] ?? "");
    const action = paymentMatch[2];
    if (!action && method === "GET") return json(await app.payments.get(id, actor));
    if (action === "approve" && method === "POST") {
      const { provider_ref } = objectBody(await readJson(request, true));
      return json(await app.payments.approve(id, actor, provider_ref));
    }
    if (action === "reject" && method === "POST") return json(await app.payments.reject(id, await readJson(request), actor));
    return methodNotAllowed(action ? "POST" : "GET");
  }

  if (path === "/v1/ledger") {
    if (method === "GET") {
      return json(await app.ledger.list({
        ref_type: url.searchParams.get("ref_type"),
        ref_id: url.searchParams.get("ref_id"),
        limit: url.searchParams.get("limit"),
      }, actor));
    }
    if (method === "POST") return json(await app.ledger.record(await readJson(request), actor), 201);
    return methodNotAllowed("GET, POST");
  }

  if (path === "/v1/ask") {
    if (method !== "POST") return methodNotAllowed("POST");
    const body = objectBody(await readJson(request));
    return json(await app.ask.ask(body.question, actor));
  }

  if (path === "/v1/audit") {
    if (method !== "GET") return methodNotAllowed("GET");
    return json(await app.recentAudit(url.searchParams.get("limit"), actor));
  }

  return null;
}

function methodNotAllowed(allow: string): Response {
  return json({ error: "Method not allowed", code: "method_not_allowed" }, 405, { allow });
}
