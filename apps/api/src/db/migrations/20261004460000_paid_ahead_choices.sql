-- 10/4 (decisions #46.1, Nic, FINAL): THE LANDLORD'S CHOICE FOR PAID-AHEAD
-- MONEY LEFT ON AN ENDED LEASE.
--
-- Before this, only a long stay's early check-out offered refund choices
-- (decisions #38 Q8); after an ordinary move-out the paid-ahead money just sat
-- on the ended lease with an admin notice. Nic: "This applies to any ended
-- lease." The landlord picks No refund / Refund all of it / Refund a different
-- amount; a refund goes back the way the money was paid (services/earlyCheckOut
-- planRefund — card to that card, bank to the bank, cash handed back at the
-- desk, credit to credit). After "No refund" or a partial refund the LANDLORD
-- chooses what happens to the rest: "Keep it" (the landlord's money; GAM-held
-- money is released to them once through a 'prepaid_draw' held item) or
-- "Leave it as their credit" (still the tenant's: an account credit that
-- follows the person and pays their bills if they rent again). GAM never
-- decides it. services/paidAheadChoice.ts is the one place this is done.
--
--   1. paid_ahead_choices — one row per decision on a lease: what was left,
--      the refund choice, what was refunded, what happened to the rest. The
--      choice values are packages/shared PAID_AHEAD_REFUND_CHOICES /
--      PAID_AHEAD_REST_CHOICES (single source).
--   2. stay_refund_parts may belong to a paid-ahead choice instead of an early
--      check-out decision (paid_ahead_choice_id), so the refund parts, their
--      Stripe runner and its retry are the SAME ones the early check-out uses
--      (never a second copy). A lease that did not come from a stay has no
--      booking, so decision_id and booking_id become nullable: exactly one
--      parent, and an early check-out part still always names its stay.
--   3. credit_uses.paid_ahead_choice_id — the rest of the money (kept, or left
--      as their credit) comes off the paid-ahead credit as a recorded spend
--      (source 'paid_ahead_choice'), like every other spend: amount_remaining
--      moves only through trg_credit_uses_apply. A refund is still a
--      'refund' use on its part (refund_part_id). The source list is
--      packages/shared money.ts CREDIT_USE_SOURCES (single source).
--
-- Expand-only: a new table, two nullable columns, NOT NULLs relaxed, CHECKs
-- that accept every existing row, one small trigger that refuses an UPDATE
-- moving the new target, and one that names a replacement part's parent. Old code always writes decision_id and booking_id, so
-- it is unaffected. No backfill needed. Safe drop: the table and the two
-- columns hold only choices made through the new screen.

CREATE TABLE IF NOT EXISTS paid_ahead_choices (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id         uuid NOT NULL REFERENCES leases(id),
  landlord_id      uuid NOT NULL REFERENCES landlords(id),
  left_amount      numeric(12,2) NOT NULL,
  refund_choice    text NOT NULL,
  refund_total     numeric(12,2) NOT NULL DEFAULT 0,
  rest_choice      text,
  rest_amount      numeric(12,2) NOT NULL DEFAULT 0,
  released_amount  numeric(12,2) NOT NULL DEFAULT 0,
  tenant_credit_ids uuid[] NOT NULL DEFAULT '{}',
  idempotency_key  text NOT NULL,
  decided_by       uuid NOT NULL REFERENCES users(id),
  decided_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT paid_ahead_choices_refund_choice_check CHECK (refund_choice IN ('no_refund', 'refund_all', 'refund_other')),
  CONSTRAINT paid_ahead_choices_rest_choice_check CHECK (rest_choice IS NULL OR rest_choice IN ('keep', 'credit')),
  CONSTRAINT paid_ahead_choices_money_check CHECK (
    left_amount > 0 AND refund_total >= 0 AND rest_amount >= 0 AND released_amount >= 0
    AND refund_total + rest_amount = left_amount AND released_amount <= rest_amount),
  CONSTRAINT paid_ahead_choices_rest_shape CHECK ((rest_amount > 0) = (rest_choice IS NOT NULL)),
  CONSTRAINT paid_ahead_choices_no_refund_shape CHECK (refund_choice <> 'no_refund' OR refund_total = 0),
  CONSTRAINT paid_ahead_choices_credit_shape CHECK (rest_choice IS DISTINCT FROM 'credit' OR cardinality(tenant_credit_ids) > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_paid_ahead_choices_idem ON paid_ahead_choices (idempotency_key);
CREATE INDEX IF NOT EXISTS idx_paid_ahead_choices_lease ON paid_ahead_choices (lease_id, decided_at DESC);
COMMENT ON TABLE paid_ahead_choices IS
  '10/4 (decisions #46.1): the landlord''s choice for paid-ahead money left on an ended lease — No refund / Refund all of it / Refund a different amount, and for the rest Keep it (released to the landlord when GAM held it: released_amount, prepaid_draw held items) or Leave it as their credit (tenant_credit_ids). Written by services/paidAheadChoice.ts only.';

ALTER TABLE stay_refund_parts ALTER COLUMN decision_id DROP NOT NULL;
ALTER TABLE stay_refund_parts ALTER COLUMN booking_id DROP NOT NULL;
ALTER TABLE stay_refund_parts ADD COLUMN IF NOT EXISTS paid_ahead_choice_id uuid REFERENCES paid_ahead_choices(id);
ALTER TABLE stay_refund_parts DROP CONSTRAINT IF EXISTS stay_refund_parts_one_parent;
ALTER TABLE stay_refund_parts ADD CONSTRAINT stay_refund_parts_one_parent
  CHECK (num_nonnulls(decision_id, paid_ahead_choice_id) = 1);
ALTER TABLE stay_refund_parts DROP CONSTRAINT IF EXISTS stay_refund_parts_stay_part_has_booking;
ALTER TABLE stay_refund_parts ADD CONSTRAINT stay_refund_parts_stay_part_has_booking
  CHECK (decision_id IS NULL OR booking_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_stay_refund_parts_paid_ahead_choice
  ON stay_refund_parts (paid_ahead_choice_id) WHERE paid_ahead_choice_id IS NOT NULL;
-- Review fix pass 2: a REPLACEMENT part (replaces_part_id — a card refund
-- Stripe sent back, or a failed card part given back in cash) belongs to the
-- same parent as the part it replaces. The early check-out's code that makes
-- those (earlyCheckOut.stripeRefundFailed / givePartBackInCash, INSERT …
-- SELECT) copies decision_id but not paid_ahead_choice_id, so for a part of
-- this screen both would be NULL and stay_refund_parts_one_parent would fail
-- the Stripe webhook every time it is sent. This fills the missing parent from
-- the replaced part (it never overrides one the insert names).
CREATE OR REPLACE FUNCTION stay_refund_parts_replacement_parent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  SELECT rp.paid_ahead_choice_id INTO NEW.paid_ahead_choice_id
    FROM stay_refund_parts rp WHERE rp.id = NEW.replaces_part_id;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_stay_refund_parts_replacement_parent ON stay_refund_parts;
CREATE TRIGGER trg_stay_refund_parts_replacement_parent BEFORE INSERT ON stay_refund_parts
  FOR EACH ROW WHEN (NEW.replaces_part_id IS NOT NULL AND NEW.decision_id IS NULL AND NEW.paid_ahead_choice_id IS NULL)
  EXECUTE FUNCTION stay_refund_parts_replacement_parent();

COMMENT ON COLUMN stay_refund_parts.paid_ahead_choice_id IS
  '10/4 (decisions #46.1): a refund part of the landlord''s choice for paid-ahead money left on an ended lease (paid_ahead_choices) instead of an early check-out decision. booking_id is the lease''s stay when it came from one, else NULL.';

ALTER TABLE credit_uses ADD COLUMN IF NOT EXISTS paid_ahead_choice_id uuid
  REFERENCES paid_ahead_choices(id) ON DELETE RESTRICT;

ALTER TABLE credit_uses DROP CONSTRAINT IF EXISTS credit_uses_one_target;
ALTER TABLE credit_uses ADD CONSTRAINT credit_uses_one_target CHECK (
  num_nonnulls(payment_id, deposit_return_id, payment_reversal_id, refund_part_id, paid_ahead_choice_id) = 1
  OR (status = 'released' AND num_nonnulls(payment_id, deposit_return_id, payment_reversal_id, refund_part_id, paid_ahead_choice_id) = 0));

ALTER TABLE credit_uses DROP CONSTRAINT IF EXISTS credit_uses_source_check;
ALTER TABLE credit_uses ADD CONSTRAINT credit_uses_source_check CHECK (source IN (
  'portal', 'autopay', 'front_desk_reader', 'desk', 'landlord_agent', 'whole_bill', 'move_out', 'reversal', 'backfill', 'refund',
  'paid_ahead_choice'));

ALTER TABLE credit_uses DROP CONSTRAINT IF EXISTS credit_uses_choice_is_paid_ahead;
ALTER TABLE credit_uses ADD CONSTRAINT credit_uses_choice_is_paid_ahead CHECK (
  paid_ahead_choice_id IS NULL OR (prepaid_credit_id IS NOT NULL AND source = 'paid_ahead_choice' AND status = 'applied'));

CREATE INDEX IF NOT EXISTS credit_uses_paid_ahead_choice_idx ON credit_uses (paid_ahead_choice_id) WHERE paid_ahead_choice_id IS NOT NULL;

CREATE OR REPLACE FUNCTION credit_uses_choice_target_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Fires only when paid_ahead_choice_id moves (the trigger's WHEN): a use's
  -- target is part of what the use IS (the same rule as refund_part_id).
  RAISE EXCEPTION 'A credit use is a record: only its status moves' USING ERRCODE = '23514';
END $$;
DROP TRIGGER IF EXISTS trg_credit_uses_choice_target_fixed ON credit_uses;
CREATE TRIGGER trg_credit_uses_choice_target_fixed BEFORE UPDATE ON credit_uses
  FOR EACH ROW WHEN (NEW.paid_ahead_choice_id IS DISTINCT FROM OLD.paid_ahead_choice_id)
  EXECUTE FUNCTION credit_uses_choice_target_fixed();
