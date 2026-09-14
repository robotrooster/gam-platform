-- S642 (Nic): "Instead of showing $199 fees from Stripe I want to see our
-- margin on that too."
--
-- GAM records what it charged the TENANT (tenant_remittances.processing_fee_amount)
-- and has never recorded what Stripe charged GAM. So the platform could show
-- fee revenue and could not show profit — the margin had to be pulled from the
-- Stripe API by hand to answer the question at all.
--
-- WHY THIS IS A SEPARATE TABLE AND NOT A COLUMN ON A PAYMENT.
-- The account is on UNBUNDLED (interchange-plus) pricing, so Stripe attributes
-- NO cost to an individual charge: every charge balance-transaction comes back
-- fee = 0 with fee_details = []. The real costs arrive as separate daily
-- aggregate lines covering that day's whole volume — "Card payments
-- (2026-09-06): Transaction network costs, $20.18". Interchange also varies by
-- card type, so two identical $500 payments genuinely cost different amounts.
-- A per-payment cost column would therefore be a number we invented. Costs are
-- stored as Stripe states them — by day, by category — and margin is exact at
-- the day and month level, which is the level at which it is actually knowable.
CREATE TABLE IF NOT EXISTS stripe_processing_costs (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  -- Stripe's own balance-transaction id. Unique so a re-run of the sync
  -- cannot double-count a cost: this is the only thing standing between the
  -- margin figure and silent inflation.
  stripe_txn_id    text NOT NULL UNIQUE,
  txn_type         text NOT NULL,            -- 'stripe_fee' | 'network_cost'
  -- What it is, in our words, so the breakdown does not depend on parsing
  -- Stripe's prose at read time.
  category         text NOT NULL,
  description      text,
  -- POSITIVE dollars of cost. Stripe posts these as negative balance moves;
  -- storing the sign flipped keeps every read from having to remember.
  amount           numeric(12,2) NOT NULL CHECK (amount >= 0),
  -- The day Stripe posted it. Its description may name an earlier period —
  -- August's bank-linking bill posts on September 1 — so both are kept.
  posted_at        timestamptz NOT NULL,
  period_start     date,
  period_end       date,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stripe_costs_posted ON stripe_processing_costs (posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_stripe_costs_category ON stripe_processing_costs (category, posted_at DESC);

COMMENT ON TABLE stripe_processing_costs IS
  'What Stripe charged GAM, as Stripe states it. Unbundled pricing attributes no cost to individual charges, so these are daily aggregates; margin is exact by day/month, never per payment.';
