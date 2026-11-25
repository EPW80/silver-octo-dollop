import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Actor } from "./auth.js";
import type { App } from "./app.js";
import { run } from "./mcp-result.js";
import { PAYMENT_STATUSES } from "./payments.js";

const line = z.object({
  sku: z.string(),
  quantity: z.number().int().positive(),
});

export function registerBusinessTools(server: McpServer, app: App, actor: Actor): void {
  server.registerTool(
    "create_order",
    {
      title: "Create order",
      description: "Place a House of Helix order. Prices come from the catalog. Stock is reserved immediately. Operator role.",
      inputSchema: {
        customer_email: z.string(),
        customer_name: z.string().optional(),
        lines: z.array(line),
        shipping_cents: z.number().int().nonnegative().optional(),
        tax_cents: z.number().int().nonnegative().optional(),
        notes: z.string().optional(),
      },
    },
    async (args) => run(() => app.orders.create(args, actor)),
  );

  server.registerTool(
    "get_order",
    {
      title: "Get order",
      description: "Read one order, its lines, and its status history.",
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => run(() => app.orders.get(id, actor)),
  );

  server.registerTool(
    "lookup_orders",
    {
      title: "Lookup orders",
      description: "Find orders by customer email and optional status.",
      inputSchema: {
        email: z.string().optional(),
        status: z.enum(["pending", "paid", "fulfilling", "shipped", "delivered", "cancelled", "refunded"]).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => run(() => app.orders.lookup(args, actor)),
  );

  server.registerTool(
    "list_orders",
    {
      title: "List orders",
      description: "Recent orders, optionally filtered by status.",
      inputSchema: {
        status: z.enum(["pending", "paid", "fulfilling", "shipped", "delivered", "cancelled", "refunded"]).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => run(() => app.orders.lookup(args, actor)),
  );

  server.registerTool(
    "update_order_status",
    {
      title: "Update order status",
      description:
        "Move an order along pending → paid → fulfilling → shipped → delivered. Cancel restores stock before shipment. Operator role.",
      inputSchema: {
        id: z.string(),
        status: z.enum(["pending", "paid", "fulfilling", "shipped", "delivered", "cancelled", "refunded"]),
        note: z.string().optional(),
      },
    },
    async ({ id, status, note }) => run(() => app.orders.updateStatus(id, { status, note }, actor)),
  );

  server.registerTool(
    "upsert_product",
    {
      title: "Upsert product",
      description: "Create or update a SKU. Opening stock and later absolute stock counts are recorded as adjustments. Operator role.",
      inputSchema: {
        sku: z.string(),
        title: z.string(),
        description: z.string().optional(),
        price_cents: z.number().int().nonnegative(),
        currency: z.string().optional(),
        stock: z.number().int().nonnegative().optional(),
        low_stock_threshold: z.number().int().nonnegative().optional(),
        active: z.boolean().optional(),
      },
    },
    async (args) => run(() => app.inventory.upsertProduct(args, actor)),
  );

  server.registerTool(
    "get_product",
    {
      title: "Get product",
      description: "Read one SKU, including stock and whether it is at or below its low-stock threshold.",
      inputSchema: { sku: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ sku }) => run(() => app.inventory.getProduct(sku, actor)),
  );

  server.registerTool(
    "list_products",
    {
      title: "List products",
      description: "List the catalog. Set low_stock to only return SKUs at or below their threshold.",
      inputSchema: { low_stock: z.boolean().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ low_stock }) => run(() => app.inventory.listProducts(low_stock === true, actor)),
  );

  server.registerTool(
    "adjust_stock",
    {
      title: "Adjust stock",
      description: "Add or remove units for a reason such as damage or a count correction. Cannot drive stock below zero. Operator role.",
      inputSchema: { sku: z.string(), delta: z.number().int(), reason: z.string() },
    },
    async (args) => run(() => app.inventory.adjust(args, actor)),
  );

  server.registerTool(
    "low_stock_report",
    {
      title: "Low stock report",
      description: "Active SKUs whose stock is at or below the threshold.",
      annotations: { readOnlyHint: true },
    },
    async () => run(() => app.inventory.lowStock(actor)),
  );

  server.registerTool(
    "create_restock_order",
    {
      title: "Create restock order",
      description: "Draft a purchase order. Stock does not change until an admin approves it and someone receives it.",
      inputSchema: {
        supplier: z.string().optional(),
        notes: z.string().optional(),
        lines: z.array(line.extend({ unit_cost_cents: z.number().int().nonnegative().optional() })),
      },
    },
    async (args) => run(() => app.inventory.createRestock(args, actor)),
  );

  server.registerTool(
    "approve_restock_order",
    {
      title: "Approve restock order",
      description: "Admin only. Moves a draft purchase order to approved. Does not change stock.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => run(() => app.inventory.approveRestock(id, actor)),
  );

  server.registerTool(
    "receive_restock_order",
    {
      title: "Receive restock order",
      description: "Mark an approved purchase order received and add its quantities to stock. Operator role.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => run(() => app.inventory.receiveRestock(id, actor)),
  );

  server.registerTool(
    "cancel_restock_order",
    {
      title: "Cancel restock order",
      description: "Cancel a draft (operator) or an approved purchase order that has not been received (admin).",
      inputSchema: { id: z.string() },
      annotations: { destructiveHint: true },
    },
    async ({ id }) => run(() => app.inventory.cancelRestock(id, actor)),
  );

  server.registerTool(
    "get_restock_order",
    {
      title: "Get restock order",
      description: "Read a purchase order and its lines.",
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => run(() => app.inventory.getRestock(id, actor)),
  );

  server.registerTool(
    "list_restocks",
    {
      title: "List restock orders",
      description:
        "Recent purchase orders. Filter by status. A draft needs an admin to approve it; an approved order can be received.",
      inputSchema: {
        status: z.enum(["draft", "approved", "received", "cancelled"]).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => run(() => app.inventory.listRestocks(args, actor)),
  );

  server.registerTool(
    "request_charge",
    {
      title: "Request a charge",
      description:
        "Create a pending charge with a Stripe payment method and idempotency key. Stripe is called only after admin approval. Operator role.",
      inputSchema: {
        amount_cents: z.number().int().positive(),
        currency: z.string().optional(),
        order_id: z.string().optional(),
        customer_email: z.string().optional(),
        idempotency_key: z.string(),
        reason: z.string().optional(),
        payment_method: z.string().optional().describe("Stripe pm_ id, required for new requests. Never send a card number."),
      },
    },
    async (args) => run(() => app.payments.requestCharge(args, actor)),
  );

  server.registerTool(
    "request_refund",
    {
      title: "Request a refund",
      description:
        "Create a pending refund against an executed charge. Stripe is not called until an admin approves it. Operator role.",
      inputSchema: {
        charge_id: z.string(),
        amount_cents: z.number().int().positive().optional(),
        idempotency_key: z.string(),
        reason: z.string().optional(),
      },
    },
    async (args) => run(() => app.payments.requestRefund(args, actor)),
  );

  server.registerTool(
    "approve_transaction",
    {
      title: "Approve and execute transaction",
      description:
        "Admin only. Approve a pending payment or reconcile an earlier attempt. A verified Stripe reference can be supplied for reconciliation.",
      inputSchema: { id: z.string(), provider_ref: z.string().optional() },
    },
    async ({ id, provider_ref }) => run(() => app.payments.approve(id, actor, provider_ref)),
  );

  server.registerTool(
    "reject_transaction",
    {
      title: "Reject transaction",
      description: "Admin only. Reject a pending charge or refund. Stripe is not called.",
      inputSchema: { id: z.string(), reason: z.string().optional() },
    },
    async ({ id, reason }) => run(() => app.payments.reject(id, { reason }, actor)),
  );

  server.registerTool(
    "get_transaction",
    {
      title: "Get transaction",
      description: "Read a charge or refund request, including status, idempotency key, and the Stripe id after execution.",
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => run(() => app.payments.get(id, actor)),
  );

  server.registerTool(
    "list_payments",
    {
      title: "List payments",
      description:
        "Recent charge and refund requests. Filter by status, kind, or order. Use approve_transaction to approve or reconcile a request.",
      inputSchema: {
        status: z.enum(PAYMENT_STATUSES).optional(),
        kind: z.enum(["charge", "refund"]).optional(),
        order_id: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => run(() => app.payments.list(args, actor)),
  );

  server.registerTool(
    "record_business_event",
    {
      title: "Record business event",
      description:
        "Write an internal record that does not move money. It is also saved in the knowledge store (collection business) unless you pass an existing item_id. Operator role.",
      inputSchema: {
        kind: z.enum(["note", "event", "record", "policy"]).optional(),
        title: z.string(),
        body: z.string().optional(),
        ref_type: z.string().optional(),
        ref_id: z.string().optional(),
        item_id: z.string().optional(),
      },
    },
    async (args) => run(() => app.ledger.record(args, actor)),
  );

  server.registerTool(
    "list_business_records",
    {
      title: "List business records",
      description: "Recent ledger records. Filter by ref_type and ref_id. These rows do not move money.",
      inputSchema: {
        ref_type: z.string().optional(),
        ref_id: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => run(() => app.ledger.list(args, actor)),
  );

  server.registerTool(
    "ask",
    {
      title: "Ask the business",
      description:
        "Answer a question from the knowledge store plus orders, stock, and internal records. The local model quotes those records. Workers AI is used only when that binding is configured.",
      inputSchema: { question: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ question }) => run(() => app.ask.ask(question, actor)),
  );

  server.registerTool(
    "list_audit",
    {
      title: "List audit log",
      description: "Recent writes and who made them. Operator or admin.",
      inputSchema: { limit: z.number().int().min(1).max(200).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ limit }) => run(() => app.recentAudit(limit, actor)),
  );
}
