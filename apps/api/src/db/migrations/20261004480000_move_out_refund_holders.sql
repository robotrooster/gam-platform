-- 10/4 (decisions #46.3 and #46.4, Nic, FINAL): MOVE-OUT — WHO REFUNDS WHICH
-- PART, AND AN UNPAID UP-FRONT "LAST MONTH'S RENT" CLOSES AT $0.
--
-- #46.3: "Deposits come from where they're held." A deposit is held by whoever
-- collected it — paid electronically through GAM, GAM holds it until move-out;
-- paid in person or into the landlord's own bank, the landlord holds it. At
-- move-out each deposit is counted, the deductions come out of it, and whoever
-- holds it refunds the rest. A tenant can have both kinds, so one refund can
-- have two payers: GAM sends only what GAM holds, and the landlord hands back
-- their own part themselves. services/depositReturn works the split out
-- (refundSplit) at preview, draft and finalize; these two columns keep what a
-- FINALIZED return decided, so the landlord's page (and anyone after) reads
-- which part GAM paid out and which part the landlord hands back — never
-- worked out again later from facts that have moved on since (a released
-- deposit payment, a payout that went).
--
-- #46.4: a deposit, or an up-front "last month's rent" (a prepaid box — a
-- lease fee tagged money_kind 'prepaid', revenue_owner 'held'), the tenant
-- never paid is no longer owed once the lease ends. It is closed the way GAM
-- closes any line nobody owes any more without erasing it: zeroed and marked
-- settled with the reason in its note (as a late fee reversed by a bank
-- deposit's date is). A prepaid box that settles becomes paid-ahead credit
-- (prepaid_fee_follows_payment) — a box closed at $0 has no money behind it,
-- and lease_prepaid_credits refuses a $0 credit (amount_original > 0), so the
-- trigger now skips a row that settles at $0. A box that settles with money
-- behind it is banked exactly as before.
--
-- The closed lines are kept with the finalized return too
-- (closed_at_move_out_lines): a closed row reads $0 once its unpaid part is
-- off, so without this the finished record could not say that a never-paid
-- deposit or last month's rent was closed, or for how much.
--
-- Expand-only: three nullable columns (NULL on every return finalized before
-- this — read as "not recorded"), a CHECK every existing row passes, and the
-- trigger function replaced with the same signature. Old code never writes
-- the columns and never settles a box at $0, so it is unaffected. No backfill
-- needed (production has no deposit returns). Safe drop: the columns.

ALTER TABLE deposit_returns
  ADD COLUMN IF NOT EXISTS refund_from_gam      numeric(10,2),
  ADD COLUMN IF NOT EXISTS refund_from_landlord numeric(10,2),
  ADD COLUMN IF NOT EXISTS closed_at_move_out_lines jsonb;

ALTER TABLE deposit_returns ADD CONSTRAINT deposit_returns_refund_holders_check
  CHECK ((refund_from_gam IS NULL OR refund_from_gam >= 0)
     AND (refund_from_landlord IS NULL OR refund_from_landlord >= 0));

COMMENT ON COLUMN deposit_returns.refund_from_gam IS
  '10/4 (decisions #46.3): the part of the refund GAM sends — only money GAM holds (deposits paid through GAM, the deposit interest it credits). Written at finalize; NULL on returns finalized before it was recorded.';
COMMENT ON COLUMN deposit_returns.closed_at_move_out_lines IS
  '10/4 (decisions #46.4): the unpaid deposits and up-front last month''s rent this move-out closed as no longer owed — [{payment_id, kind: deposit|prepaid, label, amount}]. Written at finalize; NULL on returns finalized before it was recorded.';
COMMENT ON COLUMN deposit_returns.refund_from_landlord IS
  '10/4 (decisions #46.3): the part of the refund the landlord hands back themselves — deposits paid to them in person or into their own bank. GAM never sends or nets this part. Written at finalize; NULL on returns finalized before it was recorded.';

CREATE OR REPLACE FUNCTION public.prepaid_fee_follows_payment() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  kind text;
BEGIN
  -- 10/4 (decisions #46.4): a box closed at $0 (never paid, the lease ended)
  -- has no money behind it — nothing to bank.
  IF NEW.status = 'settled' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'settled')
     AND NEW.lease_fee_id IS NOT NULL AND NEW.lease_id IS NOT NULL AND NEW.amount > 0 THEN
    SELECT money_kind INTO kind FROM lease_fees WHERE id = NEW.lease_fee_id;
    IF kind = 'prepaid' THEN
      INSERT INTO lease_prepaid_credits
        (lease_id, tenant_id, amount_original, amount_remaining, source_payment_id, note,
         funded_by, received_at)
      VALUES (NEW.lease_id, NEW.tenant_id, NEW.amount, NEW.amount, NEW.id,
              'Rent paid ahead on the lease (move-in)',
              CASE WHEN NEW.manual_method IS NULL
                         AND (NEW.platform_held
                              OR NEW.stripe_charge_id IS NOT NULL
                              OR NEW.stripe_payment_intent_id IS NOT NULL
                              OR NEW.flexpay_advance_id IS NOT NULL)
                   THEN 'gam' ELSE 'landlord' END,
              COALESCE(NEW.settled_at, now()))
      ON CONFLICT (source_payment_id) WHERE source_payment_id IS NOT NULL DO UPDATE
         SET funded_by   = EXCLUDED.funded_by,
             received_at = EXCLUDED.received_at,
             voided_at   = NULL,
             void_reason = NULL,
             updated_at  = now()
       WHERE lease_prepaid_credits.voided_at IS NOT NULL
         AND lease_prepaid_credits.amount_remaining = lease_prepaid_credits.amount_original
         AND lease_prepaid_credits.amount_original = EXCLUDED.amount_original;
    END IF;
  END IF;
  RETURN NEW;
END $$;
