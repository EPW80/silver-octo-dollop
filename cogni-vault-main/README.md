# Data bank

Shared memory and the operations desk for House of Helix Peptides. One Cloudflare Worker stores notes, documents, and JSON for Erik's Grok bots, and the same MCP server handles orders, stock, restocks, internal records, and payment requests.

Writes are stamped with the bot name on the API key. The key's role (`read`, `operator`, or `admin`) decides what that bot is allowed to do. Stripe is called only when an admin approves a pending charge or refund.

## Architecture

```text
Grok bot or script
    |  Authorization: Bearer <token>
    v
Cloudflare Worker  (stateless Streamable HTTP at /mcp, REST at /v1)
    |
    |-- D1     items, orders, stock, payment requests, ledger, audit log
    |-- R2     document bodies larger than 64 KiB
    +-- Stripe only when an admin executes a pending charge or refund
```

**D1 is the source of truth.** The knowledge store (items, collections, FTS5 keyword search, embeddings) and the business tables live in one SQLite database. Keyword search is FTS5 (`porter unicode61`).

**R2 is only for large note and document bodies.** Text at or under 64 KiB stays in D1. Larger documents go to R2 under `items/<id>`, with the first 8,000 characters kept in D1 for search.

**Semantic search does not use Vectorize or Workers AI.** Each knowledge item gets a 256-dimension feature-hash embedding (shared vocabulary, not synonyms) stored on the row. A semantic query ranks the 500 most recent matches by cosine similarity, so it works in `wrangler dev` with no extra index. Hybrid search, the default, mixes that score with the FTS rank. If the corpus outgrows the window, swap `embedDocument()` in `src/embed.ts` for Workers AI plus Vectorize.

**Money does not move until an admin approves.** A new charge requires a Stripe `pm_` payment method and an idempotency key. Requests start `pending`. Admin approval claims the row as `executing` before contacting Stripe. Rejection is available while the request is pending. Reapproving a verified, executed request returns the same row.

Charge and refund requests reserve their amounts in D1. Pending, executing, unresolved, and executed payments count toward the relevant cap. A charge requires an open order if it names one. An order reaches `paid` when verified captures, less refunds, cover its total. Partial payments leave the balance open. A refund starts from a charge with verified settlement and is capped by its captured amount.

**Reconciliation keeps the reservation in place.** A nonterminal Stripe response or an ambiguous failure keeps the payment reserved in `needs_reconciliation` or under its original execution lease. If a provider result cannot be recorded, approve returns `502 record_failed`. After the 60-second lease expires, an admin can approve the same request again. A known Stripe reference is retrieved. An unknown reference can be retried using the original idempotency key during the first 23 hours. After that, supply a matching Stripe `provider_ref` to reconcile the request. Payment results expose `settled_cents` once Stripe verifies settlement.

**The `ask` tool is grounded.** It pulls matching orders, SKUs, low stock, ledger rows, and knowledge-store hits, then answers from that briefing. The default model is local and quotes the briefing. If the Worker has an AI binding and `ANSWERER` is not `local`, the same briefing is sent to Workers AI (`@cf/meta/llama-3.1-8b-instruct-fast`). The model is not allowed to invent orders or stock; if the call fails, the local briefing is returned.

The MCP endpoint is stateless Streamable HTTP. Each POST is one JSON-RPC message and the response is `application/json`. There is no Durable Object and no legacy `/sse` session.

## Roles

| Role | Can |
| --- | --- |
| `read` | Read the knowledge store, orders, products, restocks, payments, ledger, and `ask`. |
| `operator` | Everything `read` can do, plus writes: notes, orders, stock adjustments, draft restocks, receiving an approved restock, payment requests, ledger records. |
| `admin` | Everything an operator can do, plus approve or reject a payment (the Stripe call) and approve or cancel an approved restock. |

A key with no role suffix is an operator, so older `name:token` entries keep working.

Placing an order reserves stock immediately (prices come from the catalog, not from the caller). The stock reservation, the order, its lines, and the first history event commit in one transaction, so a failure part-way leaves nothing behind. Cancelling before the order ships puts that stock back, and the cancel transition can only be applied once. A restock purchase order is draft, then admin-approved, then received. Stock increases only on receive, and a restock can only be received once.

## MCP tools

Connect to `https://<your-worker>/mcp` with `Authorization: Bearer <token>` and `Accept: application/json, text/event-stream`.

Knowledge store:

| Tool | Role | What it does |
| --- | --- | --- |
| `whoami` | read | Bot name and role. |
| `save_item` | operator | Create a note, doc, or JSON record. |
| `get_item` | read | Full item, including content. |
| `search_items` | read | `keyword`, `semantic`, or `hybrid`. |
| `list_items` | read | Newest first. Pass `next_cursor` as `cursor`. |
| `update_item` | operator | Patch one item. Original author stays. |
| `delete_item` | operator | Delete an item and its R2 body. |
| `list_collections` | read | Namespaces and counts. |
| `create_collection` | operator | Create a namespace. Saving into a new name also creates it. |
| `delete_collection` | operator | Refuses `inbox`. `force` deletes its items. |

Orders:

| Tool | Role | What it does |
| --- | --- | --- |
| `create_order` | operator | Place an order. Stock is reserved. |
| `get_order` | read | Order, lines, and status history. |
| `lookup_orders` | read | By customer email and optional status. |
| `list_orders` | read | Recent orders. |
| `update_order_status` | operator | `paid` requires verified settlement. Cancel restores unshipped stock and is blocked while a charge is unresolved. |

Inventory:

| Tool | Role | What it does |
| --- | --- | --- |
| `upsert_product` | operator | Create or update a SKU, price, and low-stock threshold. |
| `get_product` | read | One SKU, including whether it is low. |
| `list_products` | read | Catalog. `low_stock: true` filters it. |
| `adjust_stock` | operator | Add or remove units with a reason. Cannot go below zero. |
| `low_stock_report` | read | Active SKUs at or below their threshold. |
| `create_restock_order` | operator | Draft a purchase order. |
| `approve_restock_order` | admin | Draft → approved. Stock unchanged. |
| `receive_restock_order` | operator | Approved → received, and stock increases. |
| `cancel_restock_order` | operator / admin | Cancel a draft, or an approved order that has not been received. |
| `get_restock_order` | read | Purchase order and lines. |
| `list_restocks` | read | Recent purchase orders. Filter by `status` (`draft`, `approved`, `received`, `cancelled`). |

Payments and records:

| Tool | Role | What it does |
| --- | --- | --- |
| `request_charge` | operator | Pending charge. Requires `payment_method` and `idempotency_key`. No Stripe call. |
| `request_refund` | operator | Pending refund against an executed charge. |
| `approve_transaction` | admin | Approve or reconcile a payment. Accepts an optional `provider_ref` for reconciliation. |
| `reject_transaction` | admin | Reject a pending request. No Stripe call. |
| `get_transaction` | read | Status, amount, idempotency key, Stripe id after execution. |
| `list_payments` | read | Charges and refunds, filterable by `status`, `kind`, or `order_id`. This is how an admin finds the id to approve. |
| `record_business_event` | operator | Append-only internal record. Also saved in the `business` collection unless you pass an existing `item_id`. Does not move money. |
| `list_business_records` | read | Recent records, filterable by `ref_type` and `ref_id`. |
| `ask` | read | Question answered from the knowledge store and these tables. |
| `list_audit` | operator | Recent writes, with bot name and role. |

Amounts are integer cents. Order line prices are copied from the product at purchase time.

## REST

Same bearer token, or `X-Api-Key`. `GET /` and `GET /health` are public.

| Method | Path |
| --- | --- |
| `GET` | `/v1/whoami` |
| `GET` `POST` | `/v1/items`, `/v1/collections`, `/v1/orders`, `/v1/products`, `/v1/ledger` |
| `POST` | `/v1/search`, `/v1/ask`, `/v1/payments/charges`, `/v1/payments/refunds`, `/v1/restocks` |
| `GET` `PATCH` | `/v1/orders/:id`, `/v1/products/:sku` |
| `POST` | `/v1/products/:sku/adjustments` |
| `POST` | `/v1/restocks/:id/approve`, `/receive`, `/cancel` |
| `POST` | `/v1/payments/:id/approve`, `/reject` |
| `GET` | `/v1/payments`, `/v1/payments/:id`, `/v1/restocks`, `/v1/restocks/:id` |
| `GET` | `/v1/audit` |
| `DELETE` | `/v1/collections/:name` |

`GET /v1/orders?email=ada@helix.test&status=pending` looks up a customer. `GET /v1/products?low_stock=true` is the low-stock report. `GET /v1/payments?status=pending` lists payments ready for approval. Filter by `needs_reconciliation` or `executing` to find attempts requiring review. `POST /v1/payments/:id/approve` accepts an empty body for normal approval or a JSON object with `provider_ref` for reconciliation. `GET /v1/restocks?status=draft` is the purchase-order queue. Both queues accept `limit` and `cursor`.

## Auth

One Worker secret, `API_KEYS`:

```text
notes:dbk_replace_me:read,ops:dbk_replace_me_too:operator,owner:dbk_replace_me_admin:admin
```

- Names match `[A-Za-z0-9][A-Za-z0-9_.-]{0,63}`. Two tokens may share a name.
- Tokens are at least 16 characters and must not contain spaces, commas, or colons.
- Comparison walks every key. A missing or malformed secret is HTTP 503. A wrong token is HTTP 401. A role that is too low is HTTP 403.
- Every write is appended to `audit_log` with the bot name and role.

These keys are the only gate. A leaked operator token can place orders and request payments. A leaked admin token can execute them. Use a long random token per bot.

Stripe, only for the execute step:

```bash
printf '%s' 'sk_live_REPLACE_ME' | npx wrangler secret put STRIPE_SECRET_KEY
```

Do not put that value in `wrangler.jsonc`, `.dev.vars`, or git. Leave it unset until you are ready. Approve then returns HTTP 503 and the request stays `pending`.

Optional Workers AI for `ask`. Add this to `wrangler.jsonc` when you want it, and remove `ANSWERER=local` if you had set it:

```jsonc
"ai": { "binding": "AI" }
```

## Local development

Requires Node 22+.

```bash
npm install
npm test
npm run dev
```

`npm run dev` copies `.dev.vars.example` to `.dev.vars` when that file is missing, applies D1 migrations locally, and serves port **44119**.

Example tokens:

- `local-bot` — operator — `dbk_dev_local_only_change_me`
- `second-bot` — read — `dbk_dev_second_bot_key`
- `admin-bot` — admin — `dbk_dev_admin_only_change_me`

If `.dev.vars` already exists from an older checkout, add the `:role` suffixes yourself. Keys without a role are operators.

```bash
curl -s http://127.0.0.1:44119/health

curl -s http://127.0.0.1:44119/mcp \
  -H 'authorization: Bearer dbk_dev_local_only_change_me' \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Tests

```bash
npm run check      # typecheck, lint, both test projects, secrets scan
npm test           # both test projects
npm run test:node  # fast: node:sqlite and an in-memory bucket
npm run test:workers
```

There are two test projects:

- **node** (`test/*.test.ts`) covers the knowledge store, API-key roles, order pricing and stock reservation, inventory math (adjust, low stock, restock approval, receive), the refund approval flow with Stripe mocked, the Stripe request shape (no network, no card number), and `ask` against the local briefing. It stands in `node:sqlite` for D1 and a `Map` for R2.
- **workers** (`test/workers/`) runs the real Worker inside workerd with local D1 and R2 from `wrangler.jsonc`, via `@cloudflare/vitest-plugin`. It covers what the node project cannot: D1's FTS5 triggers and `json_each`, bodies over 64 KiB in R2, and stock reservation through the REST API.

`npm run lint` runs Biome. `npm run format` rewrites files with Biome's formatter. It has not been run over the existing code yet.

To click through the MCP tools, start `npm run dev`, run `npm run inspect`, and connect to `http://127.0.0.1:44119/mcp` with header `Authorization: Bearer <dev token>`.

### Secrets scan

`npm run secrets` runs gitleaks (a local binary, or the pinned Docker image) over the git history, using `.gitleaks.toml`. The allowlist covers only the `dbk_dev_`/`dbk_test_` placeholder tokens and test idempotency keys, so never give a real bot token those prefixes.

Enable the pre-commit hook once per clone:

```bash
git config core.hooksPath .githooks
```

## Deploy

Run this from a machine logged into the Cloudflare account. This repo does not deploy itself and it does not contain payment credentials.

1. Install and log in.

   ```bash
   npm install
   npx wrangler login
   ```

2. Create D1 and paste the printed `database_id` into `wrangler.jsonc`, replacing `00000000-0000-4000-8000-000000000001`.

   ```bash
   npx wrangler d1 create data-bank
   ```

3. Create the R2 bucket. The name must match `bucket_name`.

   ```bash
   npx wrangler r2 bucket create data-bank
   ```

4. Apply all D1 migrations in order, from `0001_init.sql` through `0004_payment_execution.sql`. For an existing installation, follow the [payment migration procedure](docs/LIFECYCLE.md#payment-migration) before reopening payment writes.

   ```bash
   npx wrangler d1 migrations apply data-bank --remote
   ```

5. Set the bot keys. Include a role on each token you want to restrict.

   ```bash
   printf '%s' 'notes:dbk_REPLACE_ME:read,ops:dbk_REPLACE_ME:operator,owner:dbk_REPLACE_ME:admin' | npx wrangler secret put API_KEYS
   ```

6. When you are ready for live charges, set the Stripe secret. Skip this step to leave execution disabled.

   ```bash
   printf '%s' 'sk_live_REPLACE_ME' | npx wrangler secret put STRIPE_SECRET_KEY
   ```

7. Deploy.

   ```bash
   npx wrangler deploy
   ```

The worker URL looks like `https://data-bank.<subdomain>.workers.dev`. `GET /health` is the cheap liveness probe. `GET /health?deep=1` also checks that D1 answers and that the migrations are applied, and that R2 answers, returning `503` with the failing dependency. Point a deploy health check at the deep form.

Later deploys from GitHub Actions need `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, plus the deploy step itself: `.github/workflows/staging-deploy.yml`, `production-deploy.yml`, and `rollback.yml` still contain a `CUSTOMIZE` step that fails on purpose. Fill those in (and see `docs/CUSTOMIZATION.md`) before expecting a workflow deploy to succeed. Create the database, bucket, migrations, and secrets once, before the first deploy.

### MCP connector

```text
https://data-bank.<subdomain>.workers.dev/mcp
```

Give each bot its own token so the audit log shows who wrote, and so a read-only bot cannot approve a refund.

```json
{
  "mcpServers": {
    "data-bank": {
      "url": "https://data-bank.<subdomain>.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer dbk_REPLACE_ME"
      }
    }
  }
}
```

Cursor: Settings → MCP → add a remote server, or merge that block into `~/.cursor/mcp.json`. Claude: Settings → Connectors → Add custom connector → the `/mcp` URL and the bearer token.

## Limits

- Knowledge content up to 1,000,000 bytes. Request bodies up to 1.5 MB.
- Semantic search scores the 500 most recently updated knowledge items that match the filters.
- Order lines are fixed after create. Change an unshipped order by cancelling it (stock returns) and placing a new one.
- `PATCH /v1/products/:sku` changes only the fields you send. `POST /v1/products` creates a SKU and requires `title`.
- The charge cap is cumulative per order. The refund cap uses the captured amount less all reserved and completed refunds.
- `inbox` cannot be deleted.
- There is no rate limit in the worker.

## Layout

```text
src/index.ts       auth, CORS, routing
src/mcp.ts         knowledge-store tools
src/tools.ts       orders, inventory, payments, ledger, ask
src/orders.ts      orders and status history
src/inventory.ts   SKUs, stock, restock purchase orders
src/payments.ts    pending charges and refunds, approval
src/stripe.ts      PaymentProvider and the Stripe adapter
src/ledger.ts      internal records, linked into the knowledge store
src/ask.ts         briefing plus local or Workers AI answer
src/store.ts       knowledge store
migrations/        knowledge store, business tables, indexes, and payment execution state
```
