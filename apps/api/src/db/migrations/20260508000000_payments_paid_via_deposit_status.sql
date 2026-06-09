-- S180 / A1: extend payments.status CHECK with 'paid_via_deposit'.
--
-- Locked at S177 product walkthrough: at move-out, all outstanding
-- tenant balance items (move_out fees, other fees, unpaid rent, unpaid
-- utilities) sweep into the deposit deduction. Pre-S180 the deposit-
-- return service auto-included lease_fees with due_timing IN (move_out,
-- other) — but unpaid payments rows (rent, utility, late_fee with
-- status pending/failed) were NOT pulled in. Landlord had to type them
-- as manual other_deductions if they remembered.
--
-- S180 wires the auto-sweep at calculate + finalize time. Swept payments
-- need a status that distinguishes them from a real Stripe-settled row
-- so the audit trail is clear: tenant didn't pay; deposit covered it.
-- New 'paid_via_deposit' status fills that role. Distinct from 'settled'
-- (real money) and 'failed' (still owed).
--
-- No backfill needed: all existing payments rows keep their current
-- status; the new value is reachable only via finalize from this point
-- forward.

ALTER TABLE public.payments
  DROP CONSTRAINT payments_status_check;

ALTER TABLE public.payments
  ADD CONSTRAINT payments_status_check
    CHECK (status = ANY (ARRAY[
      'pending'::text,
      'processing'::text,
      'settled'::text,
      'failed'::text,
      'returned'::text,
      'paid_via_deposit'::text
    ]));
