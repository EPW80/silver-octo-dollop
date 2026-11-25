-- House of Helix Peptides: orders, payments, inventory, ledger, and the audit log.
-- Money never moves here. payment_requests stay pending until an admin executes them.

CREATE TABLE products (
  sku TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'usd',
  stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  low_stock_threshold INTEGER NOT NULL DEFAULT 0 CHECK (low_stock_threshold >= 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE stock_adjustments (
  id TEXT PRIMARY KEY,
  sku TEXT NOT NULL REFERENCES products (sku),
  delta INTEGER NOT NULL CHECK (delta != 0),
  stock_after INTEGER NOT NULL CHECK (stock_after >= 0),
  reason TEXT NOT NULL,
  order_id TEXT,
  restock_id TEXT,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_stock_sku ON stock_adjustments (sku, created_at DESC);

CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  customer_email TEXT NOT NULL,
  customer_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'paid', 'fulfilling', 'shipped', 'delivered', 'cancelled', 'refunded')
  ),
  currency TEXT NOT NULL,
  subtotal_cents INTEGER NOT NULL CHECK (subtotal_cents >= 0),
  shipping_cents INTEGER NOT NULL DEFAULT 0 CHECK (shipping_cents >= 0),
  tax_cents INTEGER NOT NULL DEFAULT 0 CHECK (tax_cents >= 0),
  total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
  notes TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_orders_email ON orders (customer_email, created_at DESC);
CREATE INDEX idx_orders_status ON orders (status, created_at DESC);

CREATE TABLE order_lines (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  sku TEXT NOT NULL,
  title TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0)
);

CREATE INDEX idx_order_lines_order ON order_lines (order_id);

CREATE TABLE order_status_events (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_order_events ON order_status_events (order_id, created_at);

CREATE TABLE payment_requests (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('charge', 'refund')),
  order_id TEXT REFERENCES orders (id),
  charge_id TEXT,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL,
  customer_email TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL UNIQUE,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'executed', 'rejected', 'failed')),
  reason TEXT NOT NULL DEFAULT '',
  payment_method TEXT,
  provider TEXT NOT NULL DEFAULT 'stripe',
  provider_ref TEXT,
  error TEXT,
  requested_by TEXT NOT NULL,
  decided_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_payments_order ON payment_requests (order_id, created_at DESC);
CREATE INDEX idx_payments_status ON payment_requests (status, created_at DESC);

CREATE TABLE restock_orders (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('draft', 'approved', 'received', 'cancelled')),
  supplier TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  approved_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE restock_lines (
  id TEXT PRIMARY KEY,
  restock_id TEXT NOT NULL REFERENCES restock_orders (id) ON DELETE CASCADE,
  sku TEXT NOT NULL REFERENCES products (sku),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_cost_cents INTEGER NOT NULL DEFAULT 0 CHECK (unit_cost_cents >= 0)
);

CREATE INDEX idx_restock_lines ON restock_lines (restock_id);

CREATE TABLE ledger_entries (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  ref_type TEXT,
  ref_id TEXT,
  item_id TEXT,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_ledger_created ON ledger_entries (created_at DESC);
CREATE INDEX idx_ledger_ref ON ledger_entries (ref_type, ref_id);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  actor TEXT NOT NULL,
  role TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT ''
);

CREATE INDEX idx_audit_created ON audit_log (created_at DESC);
CREATE INDEX idx_audit_entity ON audit_log (entity_type, entity_id);
