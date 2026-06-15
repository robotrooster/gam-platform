-- S510: card-update tokens for customer-self-update flow.
--
-- When a customer's saved card declines or expires, the owner (or the
-- auto-charge failure path) generates a token-protected URL on the
-- marketing site. The customer clicks the link, enters a new card via
-- Stripe Elements, and the new PM replaces the saved one as their
-- default — no GAM login required on their end.
--
-- Token strategy: single-use, 7-day expiry. Single-use prevents
-- replay; 7-day window gives the customer time to act after the
-- email lands.
--
-- SAFE — additive only, no backfill.

CREATE TABLE public.business_customer_payment_update_tokens (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    token text NOT NULL,
    business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
    customer_id uuid NOT NULL REFERENCES public.business_customers(id) ON DELETE CASCADE,
    -- The invoice whose auto-charge failure triggered this token (if
    -- applicable). Lets the marketing-site UI optionally show
    -- "Invoice INV-0042 — let's get this paid" context.
    triggered_by_invoice_id uuid REFERENCES public.business_invoices(id) ON DELETE SET NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_by_user_id uuid REFERENCES public.users(id),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT business_customer_payment_update_tokens_pkey PRIMARY KEY (id),
    CONSTRAINT business_customer_payment_update_tokens_token_unique UNIQUE (token)
);
CREATE INDEX idx_bcput_customer
  ON public.business_customer_payment_update_tokens (customer_id, created_at DESC);
-- Lookup index used by the public endpoint.
CREATE INDEX idx_bcput_active_lookup
  ON public.business_customer_payment_update_tokens (token)
  WHERE used_at IS NULL;

COMMENT ON TABLE public.business_customer_payment_update_tokens IS
  'S510 single-use 7-day tokens granting a customer (no login) the ability to replace their saved Stripe payment method on the marketing site.';
