-- S583 (Nic) — FlexCharge revolving-credit billing model.
--
-- Turns FlexCharge from pay-in-full into a REVOLVING account: the merchant (the
-- lender) charges an APR on carried balances, the customer pays a minimum and
-- carries the rest, interest accrues monthly on the unpaid balance (with an
-- automatic grace period — a fully-paid balance carries nothing, so no interest).
-- See REVOLVING_CREDIT_SPEC.md. GAM's 1.5%/YEAR subscription accrues monthly off
-- the merchant, never the borrower.
--
-- No backfill needed: all new columns default to 0, so existing (pay-in-full)
-- accounts/statements read as a zero opening balance and behave unchanged until
-- the revolving cron runs on go-forward cycles.

-- Running account balance — the source of truth. Purchases raise it; payments
-- lower it; interest + late fees raise it at statement time.
ALTER TABLE flex_charge_accounts
  ADD COLUMN IF NOT EXISTS current_balance NUMERIC(12,2) NOT NULL DEFAULT 0;

-- Statement roll-forward fields. `finance_charge` (added earlier) now holds the
-- cycle's INTEREST; `service_fee` holds GAM's monthly 1.5%/12 cut; `total_due`
-- holds the full new balance (pay this to clear).
ALTER TABLE flex_charge_statements
  ADD COLUMN IF NOT EXISTS previous_balance  NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS new_purchases     NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS payments_credited NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS late_fee          NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS new_balance       NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS minimum_due       NUMERIC(12,2) NOT NULL DEFAULT 0,
  -- Cumulative payments credited to THIS statement — used to decide next cycle's
  -- interest (carried = new_balance − amount_paid) and the late fee (paid < minimum_due).
  ADD COLUMN IF NOT EXISTS amount_paid       NUMERIC(12,2) NOT NULL DEFAULT 0;
