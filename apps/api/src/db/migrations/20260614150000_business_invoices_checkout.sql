-- S494: Stripe Checkout integration for business invoices.
--
-- Adds two columns to `business_invoices`:
--   - stripe_checkout_session_id — populated when an invoice is sent
--     and Stripe Checkout is in use. Webhook handler keys on this for
--     idempotent mark-paid.
--   - hosted_pay_url — the Stripe-hosted Checkout URL the customer
--     follows to pay. Cached here so the UI doesn't have to re-create
--     the session each time the landlord views the invoice.
--
-- Both nullable: invoices created/sent before Connect is configured
-- (or for businesses that prefer manual mark-paid only) won't have
-- these set.
--
-- SAFE — additive only, no backfill.

ALTER TABLE public.business_invoices
  ADD COLUMN stripe_checkout_session_id text,
  ADD COLUMN hosted_pay_url text;

-- Unique partial index: a session id may be NULL on many rows but
-- when set must be unique (the webhook lookup keys on it).
CREATE UNIQUE INDEX uniq_business_invoices_checkout_session
  ON public.business_invoices (stripe_checkout_session_id)
  WHERE stripe_checkout_session_id IS NOT NULL;
