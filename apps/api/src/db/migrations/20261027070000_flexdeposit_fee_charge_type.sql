-- The FlexDeposit service fee gets its own charge name, and the move-in pull
-- collects it.  (10/26 — found while wiring the fee: it was computed, stamped
-- on the plan, and never actually charged.)
--
-- THE BUG.  Nic's rule is that the whole fee rides the first installment:
--
--   "If they're doing four payments, it's the first payment plus GAM's entire
--    fee right away. We get our fee at the first payment."
--
-- computeFlexDepositSchedule worked the fee out, security_deposits remembered
-- it, and the agreement stated it — but jobs/moveInBundle.ts wrote exactly ONE
-- payment row at move-in, for installment 1. The fee was never charged to
-- anybody. With FlexDeposit switched on for a move-in tomorrow, the first
-- customer would have funded their deposit and paid GAM nothing.
--
-- WHY A NAMED CHARGE RATHER THAN 'OTHERFEE'.  The resident sees this line on
-- their bill and it lands in GAM's book, so it has to say what it is. 'FLEXDEP'
-- joins 'FLEXPAY' as a GAM-revenue charge (type 'fee', revenue_owner 'gam')
-- with its own label, so no screen has to guess and nothing shows a raw code.
--
-- IT IS NOT DEPOSIT PRINCIPAL.  Installment 1 is type 'deposit' and funds the
-- tenant's own custody balance, which comes back to them at move-out. This is
-- GAM's revenue and must never be added into collected_amount or returned.
-- Separate rows is what keeps the deposit return honest.
--
-- No backfill needed: zero FlexDeposit plans exist.

ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_entry_description_check;
ALTER TABLE payments
  ADD CONSTRAINT payments_entry_description_check CHECK (entry_description = ANY (ARRAY[
    'RENT', 'SUBSCRIP', 'DEPOSIT', 'UTILITY', 'ONTIMEPAY', 'LATEFEE', 'FLEXPAY',
    'FLEXDEP', 'PROPANE', 'RETURNFEE', 'MANUALPAY', 'HOMEPMT', 'FCPAYDOWN',
    'DECLINEFEE', 'BALANCE', 'OTHERFEE'
  ]));
