-- Widen the payment status check and retain the existing rows and idempotency keys.
CREATE TABLE payment_requests_v4 (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('charge', 'refund')),
  order_id TEXT REFERENCES orders (id),
  charge_id TEXT,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL,
  customer_email TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL UNIQUE,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'executing', 'needs_reconciliation', 'executed', 'rejected', 'failed')),
  reason TEXT NOT NULL DEFAULT '',
  payment_method TEXT,
  provider TEXT NOT NULL DEFAULT 'stripe',
  provider_ref TEXT,
  error TEXT,
  requested_by TEXT NOT NULL,
  decided_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  first_attempt_at TEXT,
  attempt_id TEXT,
  lease_until TEXT,
  legacy_request INTEGER NOT NULL DEFAULT 0 CHECK (legacy_request IN (0, 1)),
  settled_cents INTEGER CHECK (settled_cents BETWEEN 1 AND amount_cents)
);

INSERT INTO payment_requests_v4 (
  id, kind, order_id, charge_id, amount_cents, currency, customer_email, idempotency_key, payload_hash,
  status, reason, payment_method, provider, provider_ref, error, requested_by, decided_by, created_at, updated_at,
  legacy_request
)
SELECT id, kind, order_id, charge_id, amount_cents, currency, customer_email, idempotency_key, payload_hash,
       status, reason, payment_method, provider, provider_ref, error, requested_by, decided_by, created_at, updated_at, 1
FROM payment_requests;

DROP TABLE payment_requests;
ALTER TABLE payment_requests_v4 RENAME TO payment_requests;

CREATE INDEX idx_payments_created ON payment_requests (created_at DESC, id DESC);
CREATE INDEX idx_payments_status ON payment_requests (status, created_at DESC, id DESC);
CREATE INDEX idx_payments_order ON payment_requests (order_id, created_at DESC, id DESC);
CREATE INDEX idx_payments_kind ON payment_requests (kind, created_at DESC, id DESC);
CREATE INDEX idx_payments_charge ON payment_requests (charge_id, status);
CREATE INDEX idx_payments_order_status ON payment_requests (order_id, status, created_at DESC, id DESC);
CREATE INDEX idx_payments_status_kind ON payment_requests (status, kind, created_at DESC, id DESC);
CREATE INDEX idx_payments_order_kind ON payment_requests (order_id, kind, created_at DESC, id DESC);

DROP INDEX idx_restocks_status;
CREATE INDEX idx_restocks_status ON restock_orders (status, created_at DESC, id DESC);
CREATE INDEX idx_restocks_created ON restock_orders (created_at DESC, id DESC);

DROP INDEX idx_orders_status;
DROP INDEX idx_orders_email;
CREATE INDEX idx_orders_status ON orders (status, created_at DESC, id DESC);
CREATE INDEX idx_orders_email ON orders (customer_email, created_at DESC, id DESC);
