-- S180 / A1: snapshot column for the auto-swept unpaid-payment total
-- on each deposit_return draft. Mirrors the cleaning_fee_amount snapshot
-- already on the row.
--
-- Stored at draft create + recomputed on applyDeductionsToDraft +
-- refreshed at finalize. Lets total_deductions stay self-consistent
-- with cleaning_fee + damage + other + unpaid_balance without re-
-- querying payments on every read.
--
-- No backfill: existing draft rows (from the dev DB) keep
-- unpaid_balance_amount=0; if a landlord re-opens an old draft, the
-- next applyDeductionsToDraft pass recomputes it.

ALTER TABLE public.deposit_returns
  ADD COLUMN unpaid_balance_amount numeric(10,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.deposit_returns.unpaid_balance_amount IS
  'Sum of the auto-swept unpaid payments (rent / utility / late_fee / fee with status pending or failed) that the deposit covers. Snapshotted at draft create + recomputed on applyDeductions + refreshed at finalize.';
