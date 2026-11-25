-- Ordering indexes for the approval queues and the recent-order listing.
-- Those queries order by created_at DESC, id DESC, which the existing
-- (status, created_at) and (customer_email, created_at) indexes do not satisfy.

CREATE INDEX idx_orders_created ON orders (created_at DESC, id DESC);
CREATE INDEX idx_payments_created ON payment_requests (created_at DESC, id DESC);
CREATE INDEX idx_restocks_status ON restock_orders (status, created_at DESC);
