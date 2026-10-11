-- S651: the last-resort ACH debit, and why its cost is a line of its own.
--
-- GAM collects what a landlord owes it by NETTING it out of money already on
-- its way to them (services/landlordGamAccount.ts). That covers a park where
-- tenants pay through the platform. It cannot cover an ALL-CASH property:
-- nothing flows, so nothing can be netted, and the balance just grows.
--
-- Nic (S650): "Never ACH-debit a landlord by default — take it out of the money
-- flowing through. When the debit is built for all-cash properties, the bank
-- cost is its own line item so the landlord doesn't dispute the charge."
--
-- Two things follow from that sentence, and this migration is both of them.
--
-- 1. NEVER BY DEFAULT. A debit needs the landlord to have said yes, in
--    writing, to this specific thing. That is not the same as having linked a
--    bank for the transaction feed — reading a balance and taking money out of
--    an account are different permissions and it would be indefensible to
--    treat one as consent for the other. Hence the authorization columns on
--    landlords: who agreed, when, from what IP, and which payment method they
--    agreed GAM could pull from. Revoking clears the timestamp; the row keeps
--    the history.
--
-- 2. THE BANK COST IS ITS OWN LINE. When GAM pulls $130 of platform fees, the
--    pull itself costs money (Stripe's ACH debit price). Rolling that into a
--    single $131.04 line is how a landlord ends up staring at a number that
--    matches no invoice they have, and calling their bank about it. So the
--    cost is charged as its own landlord_gam_charges row, kind
--    'bank_debit_cost', with the fee charges it was incurred for named in the
--    notes. The landlord's statement then reads:
--        Platform fee — September      $130.00
--        Bank transfer cost             $ 1.04
--    which is arguable-with, and that is the entire point.
--
--    Per the standing rule that GAM never eats fees, the landlord pays it. It
--    is disclosed, it is avoidable (money moving through the platform is never
--    debited), and it is the smallest of the ways to collect.

-- ── 1. the authorization ──────────────────────────────────────────────────
ALTER TABLE landlords
  ADD COLUMN gam_debit_authorized_at        TIMESTAMPTZ,
  ADD COLUMN gam_debit_authorized_by_user_id UUID REFERENCES users(id),
  ADD COLUMN gam_debit_authorized_ip        TEXT,
  ADD COLUMN gam_debit_payment_method_id    TEXT,
  ADD COLUMN gam_debit_bank_last4           TEXT,
  ADD COLUMN gam_debit_bank_name            TEXT,
  ADD COLUMN gam_debit_revoked_at           TIMESTAMPTZ;

COMMENT ON COLUMN landlords.gam_debit_authorized_at IS
  'S651: when this landlord authorized GAM to ACH-debit them for GAM charges that could not be netted out of a payout. NULL = never authorized or since revoked; debitLandlordForCharges() refuses. Linking a bank for the transaction feed does NOT set this.';

-- ── 2. the bank cost as a first-class charge kind ─────────────────────────
ALTER TABLE landlord_gam_charges
  DROP CONSTRAINT IF EXISTS landlord_gam_charges_kind_check;
ALTER TABLE landlord_gam_charges
  ADD CONSTRAINT landlord_gam_charges_kind_check
  CHECK (kind IN ('subscription', 'manual_payment_fee', 'bank_debit_cost'));

COMMENT ON COLUMN landlord_gam_charges.kind IS
  'subscription = the monthly platform fee. manual_payment_fee = a fee on a payment taken outside the platform. bank_debit_cost = S651, what the ACH pull itself cost, kept as its own line so a landlord can see what each number is rather than disputing one lump sum.';

-- ── 3. the debit attempts themselves ──────────────────────────────────────
CREATE TABLE landlord_gam_debits (
  id                    UUID PRIMARY KEY DEFAULT public.gen_random_uuid(),
  landlord_id           UUID NOT NULL REFERENCES landlords(id) ON DELETE CASCADE,
  -- what was owed, and what the pull cost, kept apart on purpose (see header)
  charges_amount        NUMERIC(12,2) NOT NULL CHECK (charges_amount > 0),
  bank_cost_amount      NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (bank_cost_amount >= 0),
  total_amount          NUMERIC(12,2) NOT NULL CHECK (total_amount > 0),
  -- 'pending'   — ACH submitted, days from settling
  -- 'succeeded' — money landed
  -- 'failed'    — bank refused (NSF, closed, mandate revoked); charges stay owed
  -- 'canceled'  — abandoned before submission
  status                TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','succeeded','failed','canceled')),
  stripe_payment_intent_id TEXT,
  payment_method_id     TEXT,
  failure_reason        TEXT,
  -- the landlord_gam_charges rows this pull was raised to collect
  charge_ids            UUID[] NOT NULL DEFAULT '{}',
  threshold_at_debit    NUMERIC(12,2),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  settled_at            TIMESTAMPTZ,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE landlord_gam_debits IS
  'S651: every time GAM pulled from a landlord''s bank because there was no payout to net against. One row per attempt, failures kept. charges_amount and bank_cost_amount are separate columns for the same reason they are separate line items — see the migration header.';

-- Only ONE debit in flight per landlord. An ACH pull takes days to settle, and
-- a daily job that cannot see the last one still sitting there would pull the
-- same fees again on day two and day three. Partial index so history is free
-- to accumulate.
CREATE UNIQUE INDEX landlord_gam_debits_one_in_flight
  ON landlord_gam_debits (landlord_id) WHERE status = 'pending';

CREATE INDEX landlord_gam_debits_landlord_idx
  ON landlord_gam_debits (landlord_id, created_at DESC);
CREATE UNIQUE INDEX landlord_gam_debits_pi_idx
  ON landlord_gam_debits (stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL;
