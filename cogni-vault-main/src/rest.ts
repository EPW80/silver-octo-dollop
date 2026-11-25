import type { App } from "./app.js";
import type { Actor } from "./auth.js";
import { objectBody } from "./fields.js";
import { decodeSegment, errorResponse, json, readJson } from "./http.js";
import { handleBusiness } from "./routes.js";

export async function handleRest(request: Request, app: App, actor: Actor): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method;

  try {
    if (path === "/v1/whoami") {
      if (method !== "GET") return methodNotAllowed("GET");
      return json({ bot: actor.bot, role: actor.role });
    }

    if (path === "/v1/collections") {
      if (method === "GET") return json({ collections: await app.bank.listCollections() });
      if (method === "POST") {
        const body = objectBody(await readJson(request));
        const collection = await app.createCollection(body.name, body.description, actor);
        return json(collection, 201);
      }
      return methodNotAllowed("GET, POST");
    }

    const collectionMatch = /^\/v1\/collections\/([^/]+)$/.exec(path);
    if (collectionMatch) {
      if (method !== "DELETE") return methodNotAllowed("DELETE");
      const name = decodeSegment(collectionMatch[1] ?? "");
      const force = url.searchParams.get("force") === "true" || url.searchParams.get("force") === "1";
      return json(await app.deleteCollection(name, force, actor));
    }

    if (path === "/v1/items") {
      if (method === "GET") {
        const page = await app.bank.listItems({
          collection: url.searchParams.get("collection"),
          type: url.searchParams.get("type"),
          author: url.searchParams.get("author"),
          tags: [...url.searchParams.getAll("tag"), ...url.searchParams.getAll("tags")],
          limit: url.searchParams.get("limit"),
          cursor: url.searchParams.get("cursor"),
        });
        return json(page);
      }
      if (method === "POST") {
        const item = await app.saveItem(await readJson(request), actor);
        return json(item, 201);
      }
      return methodNotAllowed("GET, POST");
    }

    if (path === "/v1/search") {
      if (method !== "POST") return methodNotAllowed("POST");
      const body = objectBody(await readJson(request));
      const tags = Array.isArray(body.tags) ? body.tags : [];
      const result = await app.bank.searchItems({
        query: body.query,
        mode: body.mode,
        collection: body.collection,
        type: body.type,
        author: body.author,
        tags,
        limit: body.limit,
      });
      return json(result);
    }

    const itemMatch = /^\/v1\/items\/([^/]+)$/.exec(path);
    if (itemMatch) {
      const id = decodeSegment(itemMatch[1] ?? "");
      if (method === "GET") return json(await app.bank.getItem(id));
      if (method === "PATCH") return json(await app.updateItem(id, await readJson(request), actor));
      if (method === "DELETE") return json(await app.deleteItem(id, actor));
      return methodNotAllowed("GET, PATCH, DELETE");
    }

    const business = await handleBusiness(request, app, actor, path);
    if (business) return business;

    return json({ error: "Not found", code: "not_found" }, 404);
  } catch (error) {
    return errorResponse(error);
  }
}

function methodNotAllowed(allow: string): Response {
  return json({ error: "Method not allowed", code: "method_not_allowed" }, 405, { allow });
}
