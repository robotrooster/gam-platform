-- S655 money plan M4 (Step 1). Expand-only: a new table, its triggers, a guard
-- trigger on payments, and two views. Safe for the code running today: nothing
-- writes credit_uses until the new code ships, so the payments guard (which only
-- refuses deleting a charge that carries live credit) never fires for it.
--
-- ONE LEDGER FOR EVERY SPEND OF EVERY CREDIT. A landlord-issued credit
-- (tenant_credits), deposit interest (tenant_credits, category deposit_interest)
-- and paid-ahead money (lease_prepaid_credits) are all spent through this table.
-- A use targets a charge (payment_id), a move-out pool (deposit_return_id) or a
-- clawback against a dispute (payment_reversal_id).
--
--   held      set aside by a Stripe charge still clearing
--   applied   spent
--   released  given back: unspent (the charge failed, was canceled or
--             superseded), or (release_reason 'stay_shortened', decisions #30 /
--             #35.3) landlord-issued credit spent on rent for nights a shortened
--             stay no longer has. That credit goes back to the guest as saved
--             credit and the rent row's amount comes down by the same amount,
--             so the row's own money never moves and the credit is counted once
--   reversed  a paid-ahead spend undone because the Stripe money that FUNDED the
--             credit was disputed or returned; the target row reopens for it
--
-- What the database guarantees, so no code path has to remember it:
--   * amount_remaining on both credit tables moves only here (C0 adds the guard
--     that refuses any other write), and its >= 0 check makes a double spend
--     impossible.
--   * a use pays only an unpaid, eligible landlord charge on its own lease, and
--     locks that charge, so two writers cannot both cover it. A charge whose
--     money is already in flight takes only the held use of the Stripe charge
--     that put it in flight: the use's remittance carries the charge's own
--     intent.
--   * credit one card or bank payment set aside on a charge is that payment's
--     until it is given back. A failed charge whose retry is still scheduled
--     keeps it, so no other use (held or spent) lands on that charge until the
--     retry's credit is released (creditUse.supersedeScheduledRetry).
--   * an issued credit pays only bills of the landlord who gave it; a general
--     one only its own tenant's.
--   * uses are never deleted and never edited; only their status moves, and
--     each status stamp (used, given back, undone) is written once.
--   * spent credit comes back only two ways: a paid-ahead spend whose funding
--     was disputed (reversed), and landlord-issued credit on rent a shortened
--     stay no longer owes (released, 'stay_shortened'), which takes the rent
--     row's amount down with it here, in the same statement.
--   * a charge carrying held or spent credit cannot be deleted.
--   * payments.issued_credit_amount is the sum of the row's applied uses of
--     landlord-issued credit, maintained here and nowhere else. Every path
--     locks the charge before the credit (an insert and a status move alike)
--     and sums after that lock, so two writers on one charge never lose a use.
CREATE TABLE credit_uses (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_credit_id    uuid REFERENCES tenant_credits(id),
  prepaid_credit_id   uuid REFERENCES lease_prepaid_credits(id),
  payment_id          uuid REFERENCES payments(id) ON DELETE SET NULL,
  deposit_return_id   uuid REFERENCES deposit_returns(id),
  payment_reversal_id uuid REFERENCES payment_reversals(id),
  remittance_id       uuid REFERENCES tenant_remittances(id),
  lease_id            uuid NOT NULL REFERENCES leases(id),
  amount              numeric(12,2) NOT NULL,
  billing_month       date NOT NULL,
  source              text NOT NULL,
  status              text NOT NULL DEFAULT 'held',
  release_reason      text,
  held_at             timestamptz NOT NULL DEFAULT now(),
  applied_at          timestamptz,
  released_at         timestamptz,
  created_by          uuid REFERENCES users(id),
  CONSTRAINT credit_uses_amount_positive CHECK (amount > 0),
  CONSTRAINT credit_uses_one_credit CHECK (num_nonnulls(tenant_credit_id, prepaid_credit_id) = 1),
  -- A released use whose unpaid charge was later deleted keeps its record with no target.
  CONSTRAINT credit_uses_one_target CHECK (
       num_nonnulls(payment_id, deposit_return_id, payment_reversal_id) = 1
    OR (status = 'released' AND num_nonnulls(payment_id, deposit_return_id, payment_reversal_id) = 0)),
  CONSTRAINT credit_uses_month_is_first CHECK (billing_month = date_trunc('month', billing_month)::date),
  -- Mirrored by CREDIT_USE_SOURCES in packages/shared/src/money.ts.
  CONSTRAINT credit_uses_source_check CHECK (source IN
    ('portal','autopay','front_desk_reader','desk','landlord_agent','whole_bill','move_out','reversal','backfill')),
  -- Mirrored by CREDIT_USE_STATUSES in packages/shared/src/money.ts.
  CONSTRAINT credit_uses_status_check CHECK (status IN ('held','applied','released','reversed')),
  -- Mirrored by CREDIT_USE_RELEASE_REASONS in packages/shared/src/money.ts.
  -- A use released after it was spent keeps the day it was spent: only a
  -- stay-shortened give-back of landlord-issued credit.
  CONSTRAINT credit_uses_status_stamps CHECK (
       (status = 'held'     AND applied_at IS NULL     AND released_at IS NULL     AND release_reason IS NULL)
    OR (status = 'applied'  AND applied_at IS NOT NULL AND released_at IS NULL     AND release_reason IS NULL)
    OR (status = 'released' AND applied_at IS NULL     AND released_at IS NOT NULL
        AND release_reason IN ('payment_failed','payment_canceled','superseded'))
    OR (status = 'released' AND applied_at IS NOT NULL AND released_at IS NOT NULL
        AND release_reason = 'stay_shortened')
    OR (status = 'reversed' AND applied_at IS NOT NULL AND released_at IS NOT NULL
        AND release_reason = 'funding_reversed')),
  -- Only a Stripe charge sets credit aside; everything else spends at once.
  CONSTRAINT credit_uses_held_rides_a_charge CHECK (
    status <> 'held' OR (remittance_id IS NOT NULL AND payment_id IS NOT NULL
                         AND source IN ('portal','autopay','front_desk_reader'))),
  -- A move-out use spends paid-ahead money or (Step 9 review, fix pass 2)
  -- deposit interest the tenant was credited and never spent: that interest is
  -- owed back with the deposit. Only deposit interest — never landlord-issued
  -- credit — and the trigger checks the category (a CHECK cannot read it).
  CONSTRAINT credit_uses_move_out_is_paid_ahead CHECK (
    deposit_return_id IS NULL
    OR (source = 'move_out' AND (prepaid_credit_id IS NOT NULL OR tenant_credit_id IS NOT NULL))),
  CONSTRAINT credit_uses_clawback_is_paid_ahead CHECK (
    payment_reversal_id IS NULL OR (prepaid_credit_id IS NOT NULL AND source = 'reversal')),
  CONSTRAINT credit_uses_reversed_is_paid_ahead CHECK (
    status <> 'reversed' OR (prepaid_credit_id IS NOT NULL AND payment_id IS NOT NULL))
);
COMMENT ON TABLE credit_uses IS
  'S655: THE record of every spend of a credit. held = set aside by a Stripe charge still clearing; applied = spent; released = given back: unspent (charge failed, canceled or superseded), or stay_shortened (landlord-issued credit spent on rent for nights a shortened stay no longer has: back to the guest as saved credit, and the rent row''s amount comes down by the same amount, so the row''s own money never moves); reversed = a paid-ahead spend undone because the Stripe money that FUNDED the credit was disputed or returned (the target row reopens for this amount). amount_remaining on both credit tables and payments.issued_credit_amount move only through trg_credit_uses_apply.';
COMMENT ON COLUMN credit_uses.billing_month IS
  'S655: first of the month the spend belongs to. The monthly paid-ahead draw cap counts held and applied paid-ahead uses by this month.';
COMMENT ON COLUMN credit_uses.source IS
  'S655: which path spent it. backfill = the one deploy backfill (P2), accepted only while gam.credit_backfill is on.';

CREATE INDEX idx_credit_uses_payment          ON credit_uses (payment_id) WHERE payment_id IS NOT NULL;
CREATE INDEX idx_credit_uses_remittance_held  ON credit_uses (remittance_id) WHERE status = 'held';
CREATE INDEX idx_credit_uses_remittance       ON credit_uses (remittance_id) WHERE remittance_id IS NOT NULL;
CREATE INDEX idx_credit_uses_tenant_credit    ON credit_uses (tenant_credit_id) WHERE tenant_credit_id IS NOT NULL;
CREATE INDEX idx_credit_uses_prepaid_credit   ON credit_uses (prepaid_credit_id) WHERE prepaid_credit_id IS NOT NULL;
CREATE INDEX idx_credit_uses_deposit_return   ON credit_uses (deposit_return_id) WHERE deposit_return_id IS NOT NULL;
CREATE INDEX idx_credit_uses_paid_ahead_month ON credit_uses (lease_id, billing_month)
  WHERE prepaid_credit_id IS NOT NULL AND status IN ('held','applied');

CREATE FUNCTION credit_uses_apply() RETURNS trigger LANGUAGE plpgsql AS $$
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
            OR (OLD.status = 'applied' AND NEW.status = 'released' AND NEW.release_reason = 'stay_shortened')) THEN
      RAISE EXCEPTION 'A credit use cannot go from % to %', OLD.status, NEW.status USING ERRCODE = '23514';
    END IF;
    -- Spent credit given back because a shortened stay no longer has the nights
    -- it paid (decisions #30 / #35.3): only credit the landlord issued, on rent.
    -- Deposit interest and paid-ahead money are the guest's money: what a
    -- shortened stay no longer owes of them is banked as money paid ahead.
    IF OLD.status = 'applied' AND NEW.status = 'released'
       AND (NEW.tenant_credit_id IS NULL OR NEW.payment_id IS NULL
            OR (SELECT tc.category FROM tenant_credits tc WHERE tc.id = NEW.tenant_credit_id) = 'deposit_interest'
            OR (SELECT p.type FROM payments p WHERE p.id = NEW.payment_id) IS DISTINCT FROM 'rent') THEN
      RAISE EXCEPTION 'Only credit the landlord issued, spent on rent, comes back when a stay is shortened'
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
      -- Mirrored by creditEligibleRowSql in apps/api/src/services/moneyPredicates.ts.
      IF pay.revenue_owner IS DISTINCT FROM 'landlord'
         OR pay.type NOT IN ('rent','utility','late_fee','fee')
         OR pay.entry_description IN ('FLEXPAY','HOMEPMT')
         OR (pay.entry_description = 'DEPOSIT' AND pay.lease_fee_id IS NULL)
         OR pay.work_trade_suspended_at IS NOT NULL
         OR pay.reversal_id IS NOT NULL
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
      IF cr.lease_id IS NOT NULL THEN
        IF cr.lease_id IS DISTINCT FROM NEW.lease_id THEN
          RAISE EXCEPTION 'This credit belongs to another lease' USING ERRCODE = '23514';
        END IF;
        IF cr.landlord_id IS DISTINCT FROM lease_owner THEN
          RAISE EXCEPTION 'This credit was given by another landlord, not the landlord on this lease'
            USING ERRCODE = '23514';
        END IF;
      ELSIF cr.landlord_id IS DISTINCT FROM lease_owner
         OR NOT (COALESCE(pay.tenant_id = cr.tenant_id, false) OR EXISTS (
                   SELECT 1 FROM lease_tenants lt
                    WHERE lt.lease_id = NEW.lease_id AND lt.tenant_id = cr.tenant_id)) THEN
        RAISE EXCEPTION 'A general credit pays only its own tenant''s bills with the landlord who gave it'
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
  IF TG_OP = 'UPDATE' AND OLD.status = 'applied' AND NEW.status = 'released' THEN
    UPDATE payments SET amount = amount - NEW.amount WHERE id = NEW.payment_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_credit_uses_apply AFTER INSERT OR UPDATE ON credit_uses
  FOR EACH ROW EXECUTE FUNCTION credit_uses_apply();

CREATE FUNCTION credit_uses_kept_forever() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Credit uses are kept forever' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER trg_credit_uses_kept_forever BEFORE DELETE ON credit_uses
  FOR EACH ROW EXECUTE FUNCTION credit_uses_kept_forever();
CREATE TRIGGER audit_credit_uses AFTER DELETE OR UPDATE ON credit_uses
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

-- A charge carrying held or spent credit is never deleted (unwind, stay shortening
-- and common-area cancel delete only unpaid rows; they release held credit first).
CREATE FUNCTION payments_keep_rows_with_live_credit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM credit_uses WHERE payment_id = OLD.id AND status <> 'released') THEN
    RAISE EXCEPTION 'Charge % has account credit on it and cannot be deleted', OLD.id
      USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER trg_payments_keep_rows_with_live_credit BEFORE DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION payments_keep_rows_with_live_credit();

-- Kind and funding of each use. gam_held = GAM holds the money behind it (deposit
-- interest; paid-ahead money that came through Stripe or a platform-held prepaid
-- fee). The legacy branch (the S654 join) covers paid-ahead credits written
-- before the P2 backfill stamps funded_by; C2 removes it.
CREATE VIEW v_credit_uses AS
SELECT cu.*,
       CASE WHEN cu.prepaid_credit_id IS NOT NULL THEN 'paid_ahead'
            WHEN tc.category = 'deposit_interest' THEN 'deposit_interest'
            ELSE 'issued' END AS kind,
       pc.funded_by,
       CASE WHEN cu.prepaid_credit_id IS NULL THEN tc.category = 'deposit_interest'
            ELSE COALESCE(pc.funded_by = 'gam',
                   EXISTS (SELECT 1 FROM tenant_remittances r
                            WHERE r.id = pc.source_remittance_id
                              AND r.payment_method IN ('ach','card')
                              AND r.stripe_payment_intent_id IS NOT NULL)
                   OR EXISTS (SELECT 1 FROM payments sp
                               WHERE sp.id = pc.source_payment_id AND sp.platform_held))
       END AS gam_held
  FROM credit_uses cu
  LEFT JOIN tenant_credits tc        ON tc.id = cu.tenant_credit_id
  LEFT JOIN lease_prepaid_credits pc ON pc.id = cu.prepaid_credit_id;
COMMENT ON VIEW v_credit_uses IS
  'S655: every credit use with its kind (issued | deposit_interest | paid_ahead), the paid-ahead credit''s funded_by, and gam_held (GAM holds the money behind it).';

-- Each charge split by who paid it, counting spent credit (applied, and reversed
-- uses whose reopened row carries the loss):
--   issued_credit_amount     landlord-issued credit (never income, never paid out)
--   landlord_held_credit     paid-ahead money the landlord holds (or reclassified rent)
--   gam_funded_credit        money GAM holds: GAM-held paid-ahead money + deposit interest
--   paid_ahead_credit        all paid-ahead money, whoever holds it. Under "Money
--                            received" this part counted on the day it ARRIVED, so it
--                            is $0 on the day it pays this row (Nic, 10/2)
--   deposit_interest_credit  deposit interest (new money to the landlord the day used)
--   money_part               the row's own money (card, bank, cash, check, money
--                            order, bank deposit, FlexPay float)
--   gam_held_part            what GAM holds FOR THE LANDLORD on this row: GAM-funded
--                            credit, plus the money part when Stripe or the FlexPay
--                            float paid THIS row. It is the ONLY figure a payout may
--                            carry, so it is 0 on every row whose money is not
--                            paid to the landlord when it settles:
--                              - GAM's own fees and its FlexPay pull (GAM's money);
--                              - a 'held' prepaid move-in box: it becomes paid-ahead
--                                money (M3), paid out on the row it later pays, as
--                                that row's GAM-funded credit, never on the box too;
--                              - a deposit (type deposit: the security deposit and
--                                a refundable lease-fee deposit). GAM holds it in
--                                trust (S602) and only the move-out settlement
--                                (depositReturn) releases it; paid out at settle
--                                too, it would be paid twice;
--                              - a move-out refund row (negative: the landlord owes
--                                it back).
--                            A move-out shortfall the tenant pays by card is the
--                            landlord's money and keeps its figure, as allocation
--                            pays it today.
--                            platform_held follows this figure only on the
--                            landlord's own charges (I8). A 0 here never clears
--                            it on a deposit, which keeps platform_held = TRUE
--                            while in trust (the admin "deposits held" card
--                            counts it that way).
CREATE VIEW v_payment_money AS
SELECT p.id AS payment_id,
       p.amount,
       p.issued_credit_amount,
       COALESCE(c.landlord_held_credit, 0)    AS landlord_held_credit,
       COALESCE(c.gam_funded_credit, 0)       AS gam_funded_credit,
       COALESCE(c.paid_ahead_credit, 0)       AS paid_ahead_credit,
       COALESCE(c.deposit_interest_credit, 0) AS deposit_interest_credit,
       p.amount - p.issued_credit_amount
         - COALESCE(c.landlord_held_credit, 0) - COALESCE(c.gam_funded_credit, 0) AS money_part,
       CASE WHEN p.revenue_owner = 'landlord' AND p.type <> 'deposit' AND p.amount >= 0 THEN
              COALESCE(c.gam_funded_credit, 0)
              + CASE WHEN p.status = 'settled' AND p.manual_method IS NULL
                      AND (p.stripe_charge_id IS NOT NULL OR p.flexpay_advance_id IS NOT NULL)
                     THEN p.amount - p.issued_credit_amount
                          - COALESCE(c.landlord_held_credit, 0) - COALESCE(c.gam_funded_credit, 0)
                     ELSE 0 END
            ELSE 0 END AS gam_held_part
  FROM payments p
  LEFT JOIN LATERAL (
    SELECT SUM(v.amount) FILTER (WHERE v.kind = 'paid_ahead' AND NOT v.gam_held) AS landlord_held_credit,
           SUM(v.amount) FILTER (WHERE v.gam_held)                               AS gam_funded_credit,
           SUM(v.amount) FILTER (WHERE v.kind = 'paid_ahead')                    AS paid_ahead_credit,
           SUM(v.amount) FILTER (WHERE v.kind = 'deposit_interest')              AS deposit_interest_credit
      FROM v_credit_uses v
     WHERE v.payment_id = p.id AND v.status IN ('applied','reversed')
  ) c ON TRUE;
COMMENT ON VIEW v_payment_money IS
  'S655: each charge split by who paid it. gam_held_part is the ONLY figure a payout may carry, and is 0 on every row whose money is not paid to the landlord when it settles: GAM fees, the FlexPay pull, a held prepaid move-in box (its money is paid out on the row its paid-ahead credit pays), a deposit held in trust (type deposit; only the move-out settlement releases it) and a move-out refund row. A card-paid move-out shortfall keeps its figure. A 0 here never clears platform_held on a deposit (it stays TRUE while in trust). money_part is the row''s own money; paid_ahead_credit counted under "Money received" on the day it arrived, not again here.';
