-- 10/12 (Nic) — WHO COLLECTED A DEPOSIT PAYMENT IS STORED WHEN IT IS PAID
--
-- decisions #46.3: who holds a deposit is decided by HOW IT WAS COLLECTED —
-- 'gam' when it was paid by card or bank onto GAM's balance, 'landlord' when it
-- was paid in person or into the landlord's own bank. Today that answer is
-- worked out every time it is read (leaseFeesSync.depositCollectedBySql) from
-- platform_held and released_by_deposit_return_id — columns a move-out changes
-- afterwards (finalize clears platform_held). The ledger must post a deposit
-- from what happened when it was paid, never from what the row says now
-- (gam-ledger-design-2026-10-12 §P1, M2; "projectors read facts, never current
-- state").
--
-- payments.deposit_collected_by is written at each settle of a deposit
-- payment, from that same one definition (depositCollectedBySql) — by
-- leaseFeesSync.reconcileSettledDepositPayment (every Stripe settle) and the
-- desk / bank-deposit settle (manualPaymentSettle) — and never changed while
-- that settle stands. It is cleared when that settle is undone (a bank
-- deposit match's Undo reopens the row), so the next settle writes its own.
-- NULL on every row that is not a settled deposit payment, and on a deposit
-- payment none of those facts describes (a hand-made row).
--
-- Values: DEPOSIT_COLLECTED_BY_VALUES in packages/shared.
-- Backfill needed: settled deposit payments from before today, worked out the
-- same way (scripts/oct12_ledger_source_facts_backfill.ts, named in
-- ledger_derived_facts). Production 10/12: 0 deposit payments.
-- Safe drop: ALTER TABLE payments DROP COLUMN deposit_collected_by.

ALTER TABLE payments ADD COLUMN IF NOT EXISTS deposit_collected_by text;

ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_deposit_collected_by_check;
ALTER TABLE payments ADD CONSTRAINT payments_deposit_collected_by_check
  CHECK (deposit_collected_by IS NULL OR deposit_collected_by IN ('gam', 'landlord'));

COMMENT ON COLUMN payments.deposit_collected_by IS
  '10/12 (Nic, ledger P1): who collected this deposit payment when it settled (decisions #46.3) — gam: by card or bank onto GAM''s balance; landlord: in person or into their own bank. Written at each settle from leaseFeesSync.depositCollectedBySql; cleared when that settle is undone.';
