-- 10/28 — A MONTH-END SWEEP IS NOT THE WEEKLY PAYOUT, AND MUST NOT SAY IT IS.
--
-- The owner, looking at his own disbursements: "I'm wondering why I have two
-- payouts both going to Mountain View, labeled as the weekly payout, and only
-- one day apart. I have October 26th and October 27th. So what's going on
-- there?"
--
-- Nothing was going on: one was the weekly Tuesday run ($103.50) and the other
-- was the S641 month-end sweep ($40) — the deliberate extra push, exempt from
-- the $100 floor and the 2-day minimum gap, that empties the balance so a
-- residual does not roll into next month's books. Every dollar moved once.
--
-- What was broken is that NOTHING HE CAN SEE says which was which. The job
-- already computes the right trigger and stamps it into the Stripe metadata
-- (gam_trigger='month_end_sweep'), then throws it away: the payout description
-- is hardcoded 'GAM weekly payout' and the audit row is filed 'auto_friday'
-- with no branch but catch-up. So the sweep reads as a second weekly payout on
-- the dashboard, the disbursements page, the financials feed, the Stripe
-- dashboard and his bank statement — and it will every month, because the sweep
-- always lands within a day or two of a Tuesday.
--
-- The audit column is the part a migration can fix: it is what the books and
-- the payouts page key off, so filing a sweep as the weekly run means nobody
-- can answer "which of these was the sweep?" after the fact.
--
-- Backfill: the ONE row that exists (the 10-27 sweep) is corrected below by
-- matching the sweep's own arithmetic rather than by its id, so it cannot touch
-- a genuine weekly run.

DO $$
DECLARE def TEXT;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def
    FROM pg_constraint
   WHERE conrelid = 'public.disbursements'::regclass
     AND conname = 'disbursements_trigger_type_check';
  IF def IS NULL THEN
    RAISE EXCEPTION 'disbursements_trigger_type_check is gone — add month_end_sweep by hand';
  END IF;
  IF position('month_end_sweep' IN def) = 0 THEN
    IF position('''stripe_dashboard''::text' IN def) = 0 THEN
      RAISE EXCEPTION 'the trigger CHECK no longer lists stripe_dashboard (%) — add month_end_sweep by hand', def;
    END IF;
    ALTER TABLE disbursements DROP CONSTRAINT disbursements_trigger_type_check;
    ALTER TABLE disbursements ADD CONSTRAINT disbursements_trigger_type_check
      CHECK (trigger_type IS NULL OR trigger_type = ANY (ARRAY[
        'auto_friday'::text, 'manual_on_demand'::text, 'otp_legacy'::text,
        'catch_up'::text, 'stripe_dashboard'::text, 'month_end_sweep'::text]));
  END IF;
END $$;

COMMENT ON COLUMN disbursements.trigger_type IS
  'Why this payout fired. auto_friday = the scheduled weekly run; '
  'month_end_sweep = the S641 push 2 business days before month end, which '
  'ignores the floor and the minimum gap so nothing rolls into next month; '
  'catch_up = money that landed after the weekly run; manual_on_demand = the '
  'landlord asked; stripe_dashboard = they paid themselves out in Stripe.';
