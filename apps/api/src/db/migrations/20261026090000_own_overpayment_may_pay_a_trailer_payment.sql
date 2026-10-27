-- 10/26 (Nic) — A TENANT'S OWN OVERPAYMENT MAY PAY THEIR TRAILER PAYMENT.
--
-- Kim Bowman, MH 30, October: $450 rent + $100 home payment + $39.60 water +
-- $50 late fee = $639.60. He paid $550 by bank deposit. It settled the rent,
-- the water and the late fee — exactly $539.60 — and the $10.40 left over
-- became paid-ahead credit. Nic: "for some reason, it's still saying they owe
-- $100 towards the trailer payment... I'm wondering if their account is showing
-- any credit of the $11 roughly."
--
-- It was. The net was right ($89.60 owed), but shown as $100 open beside a
-- $10.40 credit that could never reach it: home_payment is not a
-- credit-eligible TYPE and HOMEPMT is barred by entry code as well. With
-- partial payments off at Mountain View, the desk could not log $89.60 against
-- the $100 line either — so the money was stuck on both sides.
--
-- Nic's answer: let their own overpayment pay it. Scoped to PAID-AHEAD credit
-- only — the tenant's own money, against their own bill. Credit the landlord
-- ISSUED stays barred, and so does work-trade credit: hours worked and a
-- goodwill credit do not buy somebody a trailer, which is the same rule that
-- keeps work trade off a home payment. FLEXPAY stays barred to every kind of
-- credit, because that is GAM's own collection and not a landlord charge.
--
-- This replaces credit_uses_apply with the SAME function, two conditions
-- changed. Mirrored in apps/api/src/services/moneyPredicates.ts
-- (creditEligibleRowSql / creditEligibleRowForCreditSql) and enforced per
-- credit in services/creditUse buildCreditPlan, which already walks credits
-- one at a time and knows paid_ahead from issued.
--
-- No backfill: nothing is applied by this migration. Bowman's $10.40 draws onto
-- his $100 line the next time his bill is read or paid.

CREATE OR REPLACE FUNCTION public.credit_uses_apply()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  -- current_setting(..., true) is NULL when the setting was never made in this
  -- session, so the switch is read through COALESCE: NULL must mean "off".
  switch_on      boolean := COALESCE(current_setting('gam.credit_backfill', true), '') = 'on';
  backfill       boolean := switch_on AND NEW.source = 'backfill';
  live_before    boolean := false;
  applied_before boolean := false;
  live_after     boolean;
  delta          numeric(12,2) := 0;
  pay            record;
  cr             record;
  lease_owner    uuid;
  covered        numeric(12,2);
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- What a use IS never changes: its credit, its target, its amount, its
    -- month, its source, who wrote it and when.
    IF NEW.amount <> OLD.amount
       OR NEW.deposit_return_id   IS DISTINCT FROM OLD.deposit_return_id
       OR NEW.payment_reversal_id IS DISTINCT FROM OLD.payment_reversal_id
       OR NEW.tenant_credit_id    IS DISTINCT FROM OLD.tenant_credit_id
       OR NEW.prepaid_credit_id   IS DISTINCT FROM OLD.prepaid_credit_id
       OR NEW.remittance_id       IS DISTINCT FROM OLD.remittance_id
       OR NEW.source <> OLD.source
       OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.held_at <> OLD.held_at
       OR NEW.lease_id <> OLD.lease_id OR NEW.billing_month <> OLD.billing_month THEN
      RAISE EXCEPTION 'A credit use is a record: only its status moves' USING ERRCODE = '23514';
    END IF;
    -- The one other change: the FK's ON DELETE SET NULL on a released use (its
    -- unpaid charge was deleted). Nothing else may move with it.
    IF NEW.payment_id IS DISTINCT FROM OLD.payment_id THEN
      IF OLD.status = 'released' AND NEW.status = 'released'
         AND OLD.payment_id IS NOT NULL AND NEW.payment_id IS NULL
         AND NEW.applied_at     IS NOT DISTINCT FROM OLD.applied_at
         AND NEW.released_at    IS NOT DISTINCT FROM OLD.released_at
         AND NEW.release_reason IS NOT DISTINCT FROM OLD.release_reason THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'A credit use is a record: only its status moves' USING ERRCODE = '23514';
    END IF;
    -- The stamps are history: when it was used, and when and why it was given
    -- back or undone. Deposit interest counts as income on the day it is used,
    -- so moving applied_at would rewrite a report. Writing the same status again
    -- changes nothing, and may not touch a stamp either.
    IF NEW.status = OLD.status THEN
      IF NEW.applied_at        IS DISTINCT FROM OLD.applied_at
         OR NEW.released_at    IS DISTINCT FROM OLD.released_at
         OR NEW.release_reason IS DISTINCT FROM OLD.release_reason THEN
        RAISE EXCEPTION 'A credit use is a record: only its status moves' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END IF;
    IF NOT (   (OLD.status = 'held'    AND NEW.status IN ('applied','released'))
            OR (OLD.status = 'applied' AND NEW.status = 'reversed')
            OR (OLD.status = 'applied' AND NEW.status = 'released' AND NEW.release_reason = 'stay_shortened')
            OR (OLD.status = 'applied' AND NEW.status = 'released' AND NEW.release_reason = 'late_fee_credit_withdrawn')
            -- 10/18 (Nic): "we need to undo credit, but no undoing payments
            -- that were actually real money handed over." A credit the
            -- landlord gave, taken back whole: what it paid comes back off
            -- every bill it paid (services/creditUse undoIssuedCredit).
            OR (OLD.status = 'applied' AND NEW.status = 'released' AND NEW.release_reason = 'credit_undone')) THEN
      RAISE EXCEPTION 'A credit use cannot go from % to %', OLD.status, NEW.status USING ERRCODE = '23514';
    END IF;
    -- Spent credit given back because a shortened stay no longer has the nights
    -- it paid (decisions #30 / #35.3): only credit the landlord issued, on rent.
    -- Deposit interest and paid-ahead money are the guest's money: what a
    -- shortened stay no longer owes of them is banked as money paid ahead.
    IF OLD.status = 'applied' AND NEW.status = 'released' AND NEW.release_reason = 'stay_shortened'
       AND (NEW.tenant_credit_id IS NULL OR NEW.payment_id IS NULL
            OR (SELECT tc.category FROM tenant_credits tc WHERE tc.id = NEW.tenant_credit_id) = 'deposit_interest'
            OR (SELECT p.type FROM payments p WHERE p.id = NEW.payment_id) IS DISTINCT FROM 'rent') THEN
      RAISE EXCEPTION 'Only credit the landlord issued, spent on rent, comes back when a stay is shortened'
        USING ERRCODE = '23514';
    END IF;
    -- 10/6 (Nic): a late-fee credit taken back — only the credit GAM wrote to
    -- net out a never-owed late fee (category late_fee_refund, source
    -- late_fee_credit, on a late_fee row): an Undo of the bank match that
    -- credited it, or the landlord deleting that fee in the onboarding month.
    IF OLD.status = 'applied' AND NEW.status = 'released' AND NEW.release_reason = 'late_fee_credit_withdrawn'
       AND (NEW.tenant_credit_id IS NULL OR NEW.payment_id IS NULL OR NEW.source <> 'late_fee_credit'
            OR (SELECT tc.category FROM tenant_credits tc WHERE tc.id = NEW.tenant_credit_id) IS DISTINCT FROM 'late_fee_refund'
            OR (SELECT p.type FROM payments p WHERE p.id = NEW.payment_id) IS DISTINCT FROM 'late_fee') THEN
      RAISE EXCEPTION 'Only a late-fee credit on its own late fee is taken back this way'
        USING ERRCODE = '23514';
    END IF;
    -- 10/18 (Nic): a credit the landlord gave, taken back because it was
    -- typed by mistake — only a credit HE TYPED (issued_by_landlord: never
    -- deposit interest, which the tenant is owed by law; never money the
    -- tenant paid ahead; and never a credit GAM wrote itself to cancel or
    -- refund a fee, which is not his to take back), and only off a bill. The
    -- route refuses it the moment real money is on that bill
    -- (routes/tenantCredits), and the whole credit comes back or none of it
    -- does.
    IF OLD.status = 'applied' AND NEW.status = 'released' AND NEW.release_reason = 'credit_undone'
       AND (NEW.tenant_credit_id IS NULL OR NEW.payment_id IS NULL
            OR NOT COALESCE((SELECT tc.issued_by_landlord FROM tenant_credits tc
                              WHERE tc.id = NEW.tenant_credit_id), false)
            OR (SELECT tc.category FROM tenant_credits tc WHERE tc.id = NEW.tenant_credit_id) = 'deposit_interest') THEN
      RAISE EXCEPTION 'Only a credit the landlord typed himself, spent on a bill, is taken back this way'
        USING ERRCODE = '23514';
    END IF;
    -- Undoing a spend keeps the day it was spent.
    IF OLD.status = 'applied' AND NEW.applied_at IS DISTINCT FROM OLD.applied_at THEN
      RAISE EXCEPTION 'A credit use keeps the day it was used' USING ERRCODE = '23514';
    END IF;
    -- Lock order, the same as an insert: the charge first, then the credit.
    -- The issued-credit total below is then summed after every other writer of
    -- this charge has committed. (Summed by a statement that started before
    -- waiting on the charge, it would keep its old view of the uses and drop
    -- one committed meanwhile.)
    IF NEW.payment_id IS NOT NULL THEN
      PERFORM 1 FROM payments WHERE id = NEW.payment_id FOR UPDATE;
    END IF;
    live_before    := OLD.status IN ('held','applied');
    applied_before := OLD.status = 'applied';
  ELSE
    IF NEW.status NOT IN ('held','applied') THEN
      RAISE EXCEPTION 'A credit use starts held or applied' USING ERRCODE = '23514';
    END IF;
    -- The backfill source exists only for the one deploy backfill, which turns
    -- the switch on for its own transaction. Anything else using it is a bug.
    IF NEW.source = 'backfill' AND NOT switch_on THEN
      RAISE EXCEPTION 'Source backfill is only for the deploy backfill (gam.credit_backfill)'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.payment_id IS NOT NULL THEN
      -- Lock the charge so two writers cannot both pass the coverage check.
      SELECT p.lease_id, p.tenant_id, p.type, p.status, p.revenue_owner, p.entry_description,
             p.lease_fee_id, p.work_trade_suspended_at, p.reversal_id, p.unit_id, p.amount,
             p.stripe_payment_intent_id
        INTO pay FROM payments p WHERE p.id = NEW.payment_id FOR UPDATE;
      -- Credit pays only a charge still owed: pending with no Stripe intent, or
      -- failed. A pending charge that already carries an intent may have money
      -- on its way (the same rule as payableRowSql), so it takes no use. A
      -- charge whose money is in flight (processing) takes only the HELD use its
      -- own Stripe charge writes as it puts the charge in flight: the use's
      -- remittance must carry the charge's own intent (so a path that stamps the
      -- charge first stamps its remittance with the intent before holding
      -- credit). Any other use would let the credit and that money both pay the
      -- row. This is the backstop for payableRowSql and creditEligibleRowSql
      -- (services/moneyPredicates.ts), which the app checks first.
      IF NOT backfill
         AND NOT ((pay.status = 'pending' AND pay.stripe_payment_intent_id IS NULL)
                  OR pay.status = 'failed'
                  OR (pay.status = 'processing' AND NEW.status = 'held'
                      AND EXISTS (SELECT 1 FROM tenant_remittances r
                                   WHERE r.id = NEW.remittance_id
                                     AND r.stripe_payment_intent_id = pay.stripe_payment_intent_id))) THEN
        RAISE EXCEPTION 'Charge % is already paid or being paid; credit cannot pay it again', NEW.payment_id
          USING ERRCODE = '23514';
      END IF;
      -- Eligibility (shelved cases 2, 3, 4; reopened rows; move-out rows).
      -- Mirrored by creditEligibleRowSql in apps/api/src/services/moneyPredicates.ts
      -- (and, for a reopened row, creditEligibleRowForCreditSql): a row a
      -- dispute reopened (reversal_id) takes only the paid-ahead credit that
      -- same dispute gave back — the credit whose spend on the disputed
      -- original it undid ('reversed') — decisions #48.7.
      IF pay.revenue_owner IS DISTINCT FROM 'landlord'
         -- 10/26 (Nic): a tenant's OWN overpayment may pay their trailer
         -- payment. Kim Bowman paid $550 against $639.60; it settled rent,
         -- water and the late fee exactly, and the $10.40 left over became
         -- paid-ahead credit that could never touch the $100 home payment he
         -- still owed. The net was right and the money was stuck.
         --
         -- Scoped to PAID-AHEAD credit (NEW.prepaid_credit_id): it is his
         -- money, against his own bill. Credit the landlord ISSUED and
         -- work-trade credit stay barred — hours worked and a goodwill credit
         -- do not buy somebody a trailer (the same rule that keeps work trade
         -- off a home payment). FLEXPAY stays barred to every kind: that is
         -- GAM's own collection, not a landlord charge.
         OR NOT (pay.type IN ('rent','utility','late_fee','fee')
                 OR (pay.type = 'home_payment' AND NEW.prepaid_credit_id IS NOT NULL))
         OR pay.entry_description = 'FLEXPAY'
         OR (pay.entry_description = 'HOMEPMT' AND NEW.prepaid_credit_id IS NULL)
         OR (pay.entry_description = 'DEPOSIT' AND pay.lease_fee_id IS NULL)
         OR pay.work_trade_suspended_at IS NOT NULL
         OR (pay.reversal_id IS NOT NULL AND NOT (
               NEW.prepaid_credit_id IS NOT NULL AND EXISTS (
                 SELECT 1 FROM payment_reversals dg_r
                   JOIN credit_uses dg_u ON dg_u.payment_id = dg_r.payment_id
                  WHERE dg_r.id = pay.reversal_id AND dg_u.status = 'reversed'
                    AND dg_u.prepaid_credit_id = NEW.prepaid_credit_id)))
         OR pay.unit_id IS NULL
         OR pay.lease_id IS DISTINCT FROM NEW.lease_id THEN
        RAISE EXCEPTION 'Credit cannot pay charge % (not an eligible landlord charge on lease %)',
          NEW.payment_id, NEW.lease_id USING ERRCODE = '23514';
      END IF;
      -- One payment at a time. Credit a card or bank payment set aside on this
      -- charge stays that payment's until it is given back; a failed charge
      -- whose retry is still scheduled keeps it. Any other use, held or spent,
      -- would let the retry's money and this credit both pay the row. Paying
      -- over a scheduled retry releases that credit first
      -- (creditUse.supersedeScheduledRetry), so a correct path is never refused.
      IF EXISTS (SELECT 1 FROM credit_uses u
                  WHERE u.payment_id = NEW.payment_id AND u.id <> NEW.id
                    AND u.status = 'held'
                    AND u.remittance_id IS DISTINCT FROM NEW.remittance_id) THEN
        RAISE EXCEPTION 'Charge % still has credit set aside by another payment; release the scheduled retry''s credit first',
          NEW.payment_id USING ERRCODE = '23514';
      END IF;
      SELECT COALESCE(SUM(u.amount), 0) INTO covered FROM credit_uses u
       WHERE u.payment_id = NEW.payment_id AND u.status IN ('held','applied');
      IF covered > pay.amount THEN
        RAISE EXCEPTION 'Charge % would be paid twice by credit', NEW.payment_id USING ERRCODE = '23514';
      END IF;
      -- decisions #48.7: the dispute's own credit pays its reopened row only up
      -- to what the dispute gave back of it (the undone spend), never more.
      IF pay.reversal_id IS NOT NULL
         AND (SELECT COALESCE(SUM(u.amount), 0) FROM credit_uses u
               WHERE u.payment_id = NEW.payment_id AND u.prepaid_credit_id = NEW.prepaid_credit_id
                 AND u.status IN ('held','applied'))
           > (SELECT COALESCE(SUM(dg_u.amount), 0) FROM payment_reversals dg_r
                JOIN credit_uses dg_u ON dg_u.payment_id = dg_r.payment_id
               WHERE dg_r.id = pay.reversal_id AND dg_u.status = 'reversed'
                 AND dg_u.prepaid_credit_id = NEW.prepaid_credit_id) THEN
        RAISE EXCEPTION 'Charge % was reopened by a dispute: its credit pays it only up to what the dispute gave back',
          NEW.payment_id USING ERRCODE = '23514';
      END IF;
    END IF;
    IF NEW.deposit_return_id IS NOT NULL
       AND (SELECT dr.lease_id FROM deposit_returns dr WHERE dr.id = NEW.deposit_return_id)
           IS DISTINCT FROM NEW.lease_id THEN
      RAISE EXCEPTION 'Paid-ahead money joins only its own lease''s move-out' USING ERRCODE = '23514';
    END IF;
    IF NEW.prepaid_credit_id IS NOT NULL THEN
      SELECT c.lease_id, c.voided_at INTO cr FROM lease_prepaid_credits c
       WHERE c.id = NEW.prepaid_credit_id FOR UPDATE;
      IF cr.lease_id IS DISTINCT FROM NEW.lease_id THEN
        RAISE EXCEPTION 'Paid-ahead money pays only its own lease' USING ERRCODE = '23514';
      END IF;
      IF cr.voided_at IS NOT NULL THEN
        RAISE EXCEPTION 'A withdrawn credit cannot be used' USING ERRCODE = '23514';
      END IF;
    ELSE
      IF NEW.payment_id IS NULL AND NEW.deposit_return_id IS NULL THEN
        RAISE EXCEPTION 'An issued credit pays only a charge' USING ERRCODE = '23514';
      END IF;
      SELECT tc.lease_id, tc.landlord_id, tc.tenant_id, tc.status, tc.category INTO cr
        FROM tenant_credits tc WHERE tc.id = NEW.tenant_credit_id FOR UPDATE;
      IF cr.status IS DISTINCT FROM 'active' THEN
        RAISE EXCEPTION 'A voided credit cannot be used' USING ERRCODE = '23514';
      END IF;
      -- Step 9 review (fix pass 2): the one credit a move-out takes besides
      -- paid-ahead money is deposit interest on that lease (owed back with the
      -- deposit). Landlord-issued credit never joins a move-out.
      IF NEW.deposit_return_id IS NOT NULL
         AND (cr.category IS DISTINCT FROM 'deposit_interest' OR cr.lease_id IS DISTINCT FROM NEW.lease_id) THEN
        RAISE EXCEPTION 'Only deposit interest on this lease joins its move-out' USING ERRCODE = '23514';
      END IF;
      SELECT l.landlord_id INTO lease_owner FROM leases l WHERE l.id = NEW.lease_id;
      -- Every comparison below is NULL-safe: a missing tenant or landlord on
      -- either side refuses the use, it never lets it through.
      --
      -- 10/18 (Nic): "if a person has two households, right, two spaces, two
      -- bills for October, they can't pay one for October and then pay that
      -- same one for November. It does need to go on the October bill for the
      -- other spot." A credit the landlord GAVE is the household's: the space
      -- it was issued on records where he gave it, it is not a fence. So it
      -- pays any bill of that person with that company, and the app walks
      -- those bills by DUE DATE, oldest first, across every space
      -- (creditUse.buildCreditPlan). Deposit interest still stays on its own
      -- lease: GAM owes it back with THAT deposit at move-out. Money the
      -- tenant paid ahead stays with the space they paid it for, above.
      IF cr.category = 'deposit_interest' AND cr.lease_id IS NOT NULL THEN
        IF cr.lease_id IS DISTINCT FROM NEW.lease_id THEN
          RAISE EXCEPTION 'Deposit interest belongs to another lease: it goes back with that deposit'
            USING ERRCODE = '23514';
        END IF;
        IF cr.landlord_id IS DISTINCT FROM lease_owner THEN
          RAISE EXCEPTION 'This credit was given by another landlord, not the landlord on this lease'
            USING ERRCODE = '23514';
        END IF;
      ELSIF cr.landlord_id IS DISTINCT FROM lease_owner
         OR NOT (COALESCE(pay.tenant_id = cr.tenant_id, false) OR EXISTS (
                   SELECT 1 FROM lease_tenants lt
                    WHERE lt.lease_id = NEW.lease_id AND lt.tenant_id = cr.tenant_id)) THEN
        RAISE EXCEPTION 'A credit pays only its own tenant''s bills with the landlord who gave it'
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;

  live_after := NEW.status IN ('held','applied');
  -- The deploy backfill records spends that already lowered amount_remaining.
  IF NOT backfill THEN
    IF live_after AND NOT live_before THEN delta := -NEW.amount;
    ELSIF live_before AND NOT live_after THEN delta := NEW.amount;
    END IF;
    IF delta <> 0 THEN
      PERFORM set_config('gam.credit_ledger', 'on', true);
      IF NEW.tenant_credit_id IS NOT NULL THEN
        UPDATE tenant_credits SET amount_remaining = amount_remaining + delta, updated_at = now()
         WHERE id = NEW.tenant_credit_id;
      ELSE
        UPDATE lease_prepaid_credits SET amount_remaining = amount_remaining + delta, updated_at = now()
         WHERE id = NEW.prepaid_credit_id;
      END IF;
      PERFORM set_config('gam.credit_ledger', 'off', true);
    END IF;
  END IF;

  -- The sum of the row's applied landlord-issued uses, recounted only when this
  -- use enters or leaves 'applied' (held and released uses never count). The
  -- charge is locked above on both paths, so this statement's view of the uses
  -- includes every one committed before it.
  IF NEW.tenant_credit_id IS NOT NULL AND NEW.payment_id IS NOT NULL
     AND (NEW.status = 'applied') IS DISTINCT FROM applied_before THEN
    UPDATE payments SET issued_credit_amount = (
      SELECT COALESCE(SUM(u.amount), 0)
        FROM credit_uses u JOIN tenant_credits tc ON tc.id = u.tenant_credit_id
       WHERE u.payment_id = NEW.payment_id AND u.status = 'applied'
         AND tc.category <> 'deposit_interest')
     WHERE id = NEW.payment_id;
  END IF;
  -- Credit given back because a shortened stay no longer has the nights it
  -- paid takes its rent row's amount down with it, in this statement: the row
  -- then asks only what its own money (and any credit still on it) paid, so
  -- that money (amount − issued_credit_amount) never moves, no report or
  -- payout counts the given-back credit as money, and the credit is counted
  -- once, as the guest's saved credit. The caller only notes the change on
  -- the row and its invoice (services/bookingLeaseBilling).
  IF TG_OP = 'UPDATE' AND OLD.status = 'applied' AND NEW.status = 'released' AND NEW.release_reason = 'stay_shortened' THEN
    UPDATE payments SET amount = amount - NEW.amount WHERE id = NEW.payment_id;
  END IF;
  RETURN NEW;
END $function$

;
