-- S511 — business-invoice deposits + payments ledger (walkthrough Business #9).
--
-- WHY: service businesses want an upfront deposit (a booking/service deposit or
-- a materials deposit) collected before the work, with the balance due later.
-- Nic's model: deposit on the INVOICE, tagged service|materials (a label), paid
-- online via the customer portal as a first partial payment, balance later.
--
-- This requires moving business invoices off the "one full payment" assumption.
-- The new business_invoice_payments ledger records each payment (deposit, then
-- balance) and is the webhook's idempotency guard — Stripe re-delivers events,
-- and amount_paid is now an additive SUM, so a double-credit would corrupt the
-- balance. UNIQUE(stripe_checkout_session_id) makes re-delivery a no-op.
--
-- No backfill needed: existing invoices have deposit_amount 0 (behaves exactly
-- as before — the whole total is the only amount due), and their historical
-- single payment is implied by amount_paid (we do not backfill ledger rows; the
-- ledger is authoritative only for payments recorded from here forward, and the
-- webhook seeds amount_paid from SUM(ledger) only when a ledger row exists).

ALTER TABLE public.business_invoices
  ADD COLUMN deposit_amount  numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN deposit_type    text,
  ADD COLUMN deposit_paid_at timestamp with time zone;

ALTER TABLE public.business_invoices
  ADD CONSTRAINT business_invoices_deposit_amount_nonneg CHECK (deposit_amount >= 0),
  ADD CONSTRAINT business_invoices_deposit_type_check
    CHECK (deposit_type IS NULL OR deposit_type IN ('service', 'materials')),
  -- A typed deposit must have an amount, and a deposit amount must be typed.
  ADD CONSTRAINT business_invoices_deposit_pairing CHECK (
    (deposit_amount = 0 AND deposit_type IS NULL)
    OR (deposit_amount > 0 AND deposit_type IS NOT NULL)
  );

COMMENT ON COLUMN public.business_invoices.deposit_amount IS
  'S511 upfront deposit due before the balance. 0 = no deposit. Must be <= total_amount (enforced in app).';
COMMENT ON COLUMN public.business_invoices.deposit_type IS
  'S511 service|materials — a bookkeeping label for the deposit; no behavioral difference.';
COMMENT ON COLUMN public.business_invoices.deposit_paid_at IS
  'S511 stamped when cumulative amount_paid first covers deposit_amount.';

-- Per-payment ledger. amount_paid on the invoice = SUM(amount) here.
CREATE TABLE public.business_invoice_payments (
  id                          uuid DEFAULT public.gen_random_uuid() NOT NULL,
  business_id                 uuid NOT NULL,
  invoice_id                  uuid NOT NULL,
  amount                      numeric(12,2) NOT NULL,
  kind                        text NOT NULL,
  method                      text NOT NULL DEFAULT 'card',
  stripe_checkout_session_id  text,
  stripe_payment_intent_id    text,
  paid_at                     timestamp with time zone DEFAULT now() NOT NULL,
  created_at                  timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT business_invoice_payments_pkey PRIMARY KEY (id),
  CONSTRAINT business_invoice_payments_invoice_fk
    FOREIGN KEY (invoice_id) REFERENCES public.business_invoices(id) ON DELETE CASCADE,
  CONSTRAINT business_invoice_payments_amount_pos CHECK (amount > 0),
  CONSTRAINT business_invoice_payments_kind_check CHECK (kind IN ('deposit', 'balance', 'full', 'manual'))
);

-- Idempotency: one ledger row per Stripe Checkout Session. Partial unique so
-- manual (no-session) rows don't collide on null.
CREATE UNIQUE INDEX business_invoice_payments_session_key
  ON public.business_invoice_payments (stripe_checkout_session_id)
  WHERE stripe_checkout_session_id IS NOT NULL;
CREATE INDEX business_invoice_payments_invoice_idx
  ON public.business_invoice_payments (invoice_id);

COMMENT ON TABLE public.business_invoice_payments IS
  'S511 per-payment ledger for business invoices (deposit + balance). Webhook idempotency via the unique session index; invoice.amount_paid = SUM(amount).';
