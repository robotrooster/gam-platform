-- S508: saved payment methods for business customers.
--
-- When a customer pays an invoice through the Stripe Checkout flow,
-- the platform now creates a Stripe Customer + saves the payment
-- method via `setup_future_usage`. The webhook stores those refs on
-- the business_customers row so subsequent cycles (recurring billing)
-- can auto-charge off-session.
--
-- Columns:
--
--   stripe_customer_id          — Customer object on the GAM PLATFORM
--                                 account (not the connected biz). Saved
--                                 PMs attach here.
--   default_payment_method_id   — pm_xxx — first saved card the
--                                 customer used. v1 only tracks one.
--   payment_method_brand        — UI display ("visa", "mastercard")
--   payment_method_last4        — UI display ("4242")
--   payment_method_exp_month    — UI display + expiry warning
--   payment_method_exp_year
--
-- Architectural choice: platform-side Customer (not connected-account
-- Customer) because destination charges pass through the platform's
-- balance first; that lets the same saved PM serve a customer across
-- multiple GAM businesses they may pay over time without re-entering
-- card details.
--
-- SAFE — additive only, no backfill.

ALTER TABLE public.business_customers
  ADD COLUMN stripe_customer_id        text,
  ADD COLUMN default_payment_method_id text,
  ADD COLUMN payment_method_brand      text,
  ADD COLUMN payment_method_last4      text,
  ADD COLUMN payment_method_exp_month  integer,
  ADD COLUMN payment_method_exp_year   integer,
  ADD CONSTRAINT business_customers_payment_method_exp_month_range CHECK (
    payment_method_exp_month IS NULL
    OR (payment_method_exp_month BETWEEN 1 AND 12)
  ),
  ADD CONSTRAINT business_customers_payment_method_exp_year_range CHECK (
    payment_method_exp_year IS NULL
    OR (payment_method_exp_year BETWEEN 2024 AND 2100)
  );

-- Index for the webhook's reverse lookup ("which customer is this
-- stripe Customer for"). Partial — only relevant when the column is
-- non-null. NOT UNIQUE because the same Stripe Customer can map to
-- many business_customers rows (one per business that the same
-- end-user pays).
CREATE INDEX idx_business_customers_stripe_customer_id
  ON public.business_customers (stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

-- Auto-charge failure tracking on the invoice side.
ALTER TABLE public.business_invoices
  ADD COLUMN auto_charge_attempted_at timestamp with time zone,
  ADD COLUMN auto_charge_last_error   text;

COMMENT ON COLUMN public.business_customers.stripe_customer_id IS
  'S508 platform-side Stripe Customer (cus_xxx). Created on first Checkout payment with save-card. Recurring cycles auto-charge against the saved PM here.';
COMMENT ON COLUMN public.business_invoices.auto_charge_attempted_at IS
  'S508 set when a recurring cycle attempted an off-session charge. If auto_charge_last_error is also set, the charge failed and the invoice remains in draft for owner follow-up.';
