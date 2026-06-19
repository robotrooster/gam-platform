-- Customer self-service portal access tokens (S502).
--
-- A business's customer has no GAM login. To let them see their whole invoice
-- history + outstanding balance and pay any open invoice (instead of one
-- hosted-pay link per invoice), the business issues a per-customer portal
-- token. Unlike the single-use card-update token (S510), this one is REUSABLE
-- for the life of the relationship — the customer bookmarks it and returns —
-- with a long expiry and host-side revocation.
--
-- No backfill needed — new table; a customer has no token until the business
-- issues one.
CREATE TABLE business_customer_portal_tokens (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  token text NOT NULL,
  business_id uuid NOT NULL,
  customer_id uuid NOT NULL REFERENCES business_customers(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_by_user_id uuid,
  created_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT business_customer_portal_tokens_pkey PRIMARY KEY (id),
  CONSTRAINT business_customer_portal_tokens_token_key UNIQUE (token)
);

CREATE INDEX idx_business_customer_portal_tokens_customer ON business_customer_portal_tokens (customer_id);
-- One active (un-revoked) token per customer is the common case; this speeds
-- the "does this customer already have a live link?" lookup at issue time.
CREATE INDEX idx_business_customer_portal_tokens_business ON business_customer_portal_tokens (business_id);
