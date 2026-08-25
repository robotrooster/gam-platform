-- What each landlord owes GAM, and whether it has been collected.
--
-- S620 (Nic): "if six people pay cash and then four people pay card for the
-- remainder, we'll just take it all out of the card balance. It doesn't make
-- sense to debit the account of the landlord — that's just more money moving
-- back and forth, and we wanna eliminate moves."
--
-- WHAT WAS MISSING. GAM booked revenue it had no way to collect. When a tenant
-- pays CASH and the landlord absorbs the $10 manual-payment fee, the fee was
-- written into platform_revenue_ledger as GAM income — but no money passed
-- through GAM on a cash payment, so there was nothing to take it from, and
-- nothing anywhere recorded that the landlord still owed it. The comment on
-- that code says payouts "net it out"; grep says nothing does. Same for the
-- monthly subscription when the property has payer='landlord'.
--
-- This table is the missing half: a per-landlord running account of what GAM
-- has charged and what it has actually collected. Outstanding is simply
-- SUM(amount - collected_amount).
--
-- COLLECTION ORDER, per Nic:
--   1. Net it out of money already flowing to the landlord. This is the normal
--      path and the only one that moves no extra money. services/
--      landlordPassthrough.ts nets it during RESERVE, alongside the reversal
--      receivables that already work this way.
--   2. Only if the balance crosses the property's threshold with nothing to net
--      against, debit the landlord. Last resort, not the default.
--
-- Nic on why 2 should be rare: at Oak Park one ACH rent payment offsets ~44
-- cash fees, and the park does not have 44 spaces. "You're gonna have a mix of
-- cash, card, ACH, and I don't think you're ever gonna really hit that
-- threshold." So when it DOES fire we want to know, and know how close others
-- came — hence the high-water mark below.

CREATE TABLE landlord_gam_charges (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  landlord_id   uuid NOT NULL REFERENCES landlords(id) ON DELETE CASCADE,
  -- Nullable: the subscription is per-property, an absorbed manual fee is
  -- traceable to one, but a future account-level charge may be neither.
  property_id   uuid REFERENCES properties(id) ON DELETE SET NULL,
  kind          text NOT NULL CHECK (kind IN ('subscription', 'manual_payment_fee')),
  amount        numeric(12,2) NOT NULL CHECK (amount > 0),
  -- Partial collection is the DESIGN here, unlike reversal netting which is
  -- full-net-or-nothing: taking $50 of a $70 debt out of this week's money and
  -- carrying $20 is exactly what avoids a bank debit.
  collected_amount numeric(12,2) NOT NULL DEFAULT 0 CHECK (collected_amount >= 0),
  collected_at  timestamptz,
  -- What produced this charge, so it can never be posted twice.
  source_type   text NOT NULL,
  source_id     uuid,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT collected_never_exceeds_amount CHECK (collected_amount <= amount)
);

-- One charge per source event. A retried accrual run or a re-recorded manual
-- payment must not bill the landlord twice.
CREATE UNIQUE INDEX landlord_gam_charges_source_uniq
  ON landlord_gam_charges (source_type, source_id)
  WHERE source_id IS NOT NULL;

-- The hot query is "what does this landlord still owe" — partial index so it
-- stays cheap as collected history accumulates.
CREATE INDEX landlord_gam_charges_outstanding_idx
  ON landlord_gam_charges (landlord_id)
  WHERE collected_amount < amount;

-- Per-property debit threshold. Nic: "maybe we raise the limit per property...
-- if the fees are not worth the extra money movement, maybe we raise that to a
-- two hundred dollar threshold and wait for the card or ACH payment to come
-- in, to make sure we're saving that money. Every dollar helps in these early
-- stages." Default $100, tunable per property once the metrics are in.
ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS gam_debit_threshold numeric(12,2) NOT NULL DEFAULT 100.00;

COMMENT ON COLUMN properties.gam_debit_threshold IS
  'Outstanding balance owed to GAM at which we debit the landlord directly '
  'rather than waiting to net it out of their next disbursement. Raise it when '
  'the cost of the movement outweighs the fees. Default $100 (S620).';

-- The near-miss record. Nic: "we should flag those properties when that
-- happens and see how close it was to happening." Written on every netting
-- pass, so a property that peaked at $80 without ever tripping is visible
-- BEFORE the threshold needs raising.
CREATE TABLE landlord_gam_balance_marks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  landlord_id   uuid NOT NULL REFERENCES landlords(id) ON DELETE CASCADE,
  peak_owed     numeric(12,2) NOT NULL,
  threshold     numeric(12,2) NOT NULL,
  debited       boolean NOT NULL DEFAULT FALSE,
  observed_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX landlord_gam_balance_marks_landlord_idx
  ON landlord_gam_balance_marks (landlord_id, observed_at DESC);
