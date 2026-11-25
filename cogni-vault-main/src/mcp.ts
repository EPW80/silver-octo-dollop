import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import { z } from "zod";
import type { App } from "./app.js";
import type { Actor } from "./auth.js";
import { json } from "./http.js";
import { ok, run } from "./mcp-result.js";
import { registerBusinessTools } from "./tools.js";

const INSTRUCTIONS = [
  "Data bank is the shared memory for House of Helix Peptides and for general notes.",
  "The author of a write is the bot bound to the API key. Roles are read, operator, and admin.",
  "Orders, stock, restocks, and internal records live beside the knowledge store.",
  "request_charge and request_refund only create a pending request. approve_transaction is admin-only and is what calls Stripe.",
  "ask answers from the knowledge store and the business tables. Do not invent numbers that are not in the tool result.",
  "Collections are namespaces. The default collection is inbox. Business records also land in the business collection.",
].join(" ");

const contentSchema = z
  .union([z.string(), z.number(), z.boolean(), z.null(), z.record(z.string(), z.unknown()), z.array(z.unknown())])
  .describe("Text for note and doc. For type data, any JSON value or a JSON string.");

const tagSchema = z.array(z.string()).optional().describe("Short labels. Stored lowercased.");

const collectionSchema = z
  .string()
  .optional()
  .describe("Namespace slug. Spaces become hyphens. Omit to use inbox.");

export async function handleMcp(request: Request, app: App, actor: Actor): Promise<Response> {
  if (request.method !== "POST" && request.method !== "DELETE") {
    return json(
      {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32000,
          message: "POST JSON-RPC messages to /mcp. This server speaks stateless Streamable HTTP and returns JSON responses.",
        },
      },
      405,
      { allow: "POST, DELETE" },
    );
  }

  const server = new McpServer(
    { name: "data-bank", version: "0.2.0" },
    {
      instructions: INSTRUCTIONS,
      jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
    },
  );
  registerTools(server, app, actor);
  registerBusinessTools(server, app, actor);

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  try {
    await server.connect(transport);
    return await transport.handleRequest(request);
  } catch (error) {
    console.error(error);
    return json(
      { jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal error" } },
      500,
    );
  } finally {
    await server.close().catch(() => undefined);
  }
}

function registerTools(server: McpServer, app: App, actor: Actor): void {
  server.registerTool(
    "whoami",
    {
      title: "Who am I",
      description: "Return the bot name and role (read, operator, or admin) bound to the API key calling this server.",
      annotations: { readOnlyHint: true },
    },
    async () => ok({ bot: actor.bot, role: actor.role }),
  );

  server.registerTool(
    "save_item",
    {
      title: "Save item",
      description:
        "Create a note, document, or JSON record. Author is taken from the API key. Large bodies are stored in R2 automatically.",
      inputSchema: {
        title: z.string().describe("Required. Up to 200 characters."),
        content: contentSchema,
        type: z.enum(["note", "doc", "data"]).optional().describe("Defaults to note, or data when content is a JSON value."),
        tags: tagSchema,
        source: z.string().optional().describe("Free-text origin, such as a chat, URL, or filename."),
        collection: collectionSchema,
        metadata: z.record(z.string(), z.unknown()).optional().describe("Small JSON object stored with the item."),
      },
      annotations: { destructiveHint: false },
    },
    async (args) => run(() => app.saveItem(args, actor)),
  );

  server.registerTool(
    "get_item",
    {
      title: "Get item",
      description: "Fetch one item by id, including its full content.",
      inputSchema: { id: z.string().describe("Item id, itm_ followed by 32 hex characters.") },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => run(() => app.bank.getItem(id)),
  );

  server.registerTool(
    "search_items",
    {
      title: "Search items",
      description:
        "Search by keyword (FTS5), semantic similarity (local term embeddings over the 500 most recent matches), or hybrid (the default). Filter by collection, type, tag, or author.",
      inputSchema: {
        query: z.string().describe("Words to search for. At least one word of 2+ characters."),
        mode: z.enum(["keyword", "semantic", "hybrid"]).optional().describe("Defaults to hybrid."),
        collection: z.string().optional(),
        type: z.enum(["note", "doc", "data"]).optional(),
        tags: z.array(z.string()).optional().describe("Item must have every tag."),
        author: z.string().optional().describe("Bot name that originally wrote the item."),
        limit: z.number().int().min(1).max(50).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => run(() => app.bank.searchItems(args)),
  );

  server.registerTool(
    "list_items",
    {
      title: "List recent items",
      description: "List items newest first. Pass next_cursor back as cursor to get the next page. Does not include full content.",
      inputSchema: {
        collection: z.string().optional(),
        type: z.enum(["note", "doc", "data"]).optional(),
        tags: z.array(z.string()).optional(),
        author: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => run(() => app.bank.listItems(args)),
  );

  server.registerTool(
    "update_item",
    {
      title: "Update item",
      description: "Patch an item. Only fields you send are changed. updated_by becomes the calling bot. The original author stays.",
      inputSchema: {
        id: z.string(),
        title: z.string().optional(),
        content: contentSchema.optional(),
        type: z.enum(["note", "doc", "data"]).optional(),
        tags: z.array(z.string()).optional().describe("Replaces the whole tag list."),
        source: z.string().optional(),
        collection: z.string().optional(),
        metadata: z.record(z.string(), z.unknown()).optional().describe("Replaces the metadata object."),
      },
    },
    async (args) => {
      const { id, ...patch } = args;
      return run(() => app.updateItem(id, patch, actor));
    },
  );

  server.registerTool(
    "delete_item",
    {
      title: "Delete item",
      description: "Permanently delete one item and its stored body.",
      inputSchema: { id: z.string() },
      annotations: { destructiveHint: true },
    },
    async ({ id }) => run(() => app.deleteItem(id, actor)),
  );

  server.registerTool(
    "list_collections",
    {
      title: "List collections",
      description: "List namespaces and how many items each holds.",
      annotations: { readOnlyHint: true },
    },
    async () => run(() => app.bank.listCollections().then((collections) => ({ collections }))),
  );

  server.registerTool(
    "create_collection",
    {
      title: "Create collection",
      description: "Create an empty namespace. Saving an item into a new name also creates it.",
      inputSchema: {
        name: z.string().describe("Slug. Spaces become hyphens."),
        description: z.string().optional(),
      },
    },
    async ({ name, description }) => run(() => app.createCollection(name, description, actor)),
  );

  server.registerTool(
    "delete_collection",
    {
      title: "Delete collection",
      description: "Delete an empty collection. inbox cannot be deleted. Pass force=true to delete the collection and every item in it.",
      inputSchema: {
        name: z.string(),
        force: z.boolean().optional(),
      },
      annotations: { destructiveHint: true },
    },
    async ({ name, force }) => run(() => app.deleteCollection(name, force ?? false, actor)),
  );
}
