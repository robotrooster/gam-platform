-- 10/27 (Nic) — FLEXDEPOSIT EARNS MONEY AND CARRIES RISK. BOOK BOTH.
--
-- Two gaps found by a recon pass the day FlexDeposit went live, both of which
-- would have shown Nic the wrong number from the first plan onward.
--
-- 1. THE FEE WAS NEVER ON THE BOOK. FlexDeposit's service fee is written as a
--    payments row (type='fee', entry_description='FLEXDEP', revenue_owner='gam')
--    and nothing ever posted it to platform_revenue_ledger — GAM's one revenue
--    book. allocation.ts hard-throws on a non-landlord revenue_owner, so no
--    posting could ever follow from the allocation path either. FlexPay's cycle
--    fee IS booked ('flexpay_subscription'), which makes this an asymmetry
--    rather than a convention: every admin money figure would have under-read
--    GAM's income by every FlexDeposit fee ever collected.
--
-- 2. NOTHING RECORDED WHAT GAM PAYS OUT. Nic, settling the product's shape:
--    "Any deposits we hold are absolutely going to the landlord. That is our
--    risk to take, and that is why we are making the money on the flex
--    deposit... The landlord gets what they're owed, full stop."
--    So when a resident stops funding and their landlord's move-out deductions
--    reach into the part never funded, GAM covers the difference in cash. That
--    is a real outflow against real revenue and it needs a line of its own, not
--    an 'adjustment'.
--
-- WHY FOUR TYPES AND NOT ONE. The three fee kinds are already impossible to
-- tell apart in `payments` (all of them type='fee' + 'FLEXDEP', separable only
-- by free-text notes), and the shortfall is not revenue at all — it is revenue
-- spent. Collapsing them would make the book unable to answer the only question
-- the reserve asks: fees banked, less shortfalls paid.
--
--   flexdeposit_fee          the enrollment service fee, from
--                            flexdeposit_fee_schedule, collected whole with
--                            installment 1.
--   flexdeposit_move_fee     the flat fee for moving a custody balance to a
--                            new unit ($25 paid in full, $5 to log the move),
--                            from flexdeposit_move_fee_schedule.
--   flexdeposit_shortfall    NEGATIVE. Cash GAM paid a landlord for the part of
--                            a deposit the resident never funded. Signed
--                            negative so SUM(amount) over the whole book is
--                            GAM's true position with no special-casing — the
--                            same convention 'adjustment' already uses.
--   flexdeposit_recovery     a shortfall later recovered (a resident who pays
--                            after the fact through GAM-first routing). Positive.
--
-- NO BACKFILL NEEDED: production has zero FlexDeposit plans, zero installments
-- and zero FLEXDEP payments rows, so there is no history to restate. Verified
-- read-only before writing this.
--
-- EXPAND ONLY. This drops and recreates the CHECK with a superset of its
-- existing values; every value that was legal before is still legal, so it
-- cannot refuse a row that already exists. The matching shared constant is
-- PLATFORM_REVENUE_TYPES in packages/shared/src/money.ts — both must list the
-- same values or the drift is a bug (CLAUDE.md, single source of truth).

ALTER TABLE public.platform_revenue_ledger
  DROP CONSTRAINT IF EXISTS platform_revenue_ledger_type_check;

ALTER TABLE public.platform_revenue_ledger
  ADD CONSTRAINT platform_revenue_ledger_type_check CHECK (type = ANY (ARRAY[
    'banking_spread'::text,
    'manual_withdrawal_fee'::text,
    'placement_fee_share'::text,
    'platform_fee_subscription'::text,
    'screening_margin'::text,
    'adjustment'::text,
    'flexpay_subscription'::text,
    'device_markup'::text,
    -- 10/27: FlexDeposit, which earned money with nowhere to put it.
    'flexdeposit_fee'::text,
    'flexdeposit_move_fee'::text,
    'flexdeposit_shortfall'::text,
    'flexdeposit_recovery'::text
  ]));

COMMENT ON COLUMN public.platform_revenue_ledger.type IS
  'What GAM earned or spent. flexdeposit_shortfall is NEGATIVE (cash paid to a '
  'landlord for a deposit the resident never funded); flexdeposit_recovery is '
  'that money coming back. Mirrored by PLATFORM_REVENUE_TYPES in '
  'packages/shared/src/money.ts — keep both lists identical.';
