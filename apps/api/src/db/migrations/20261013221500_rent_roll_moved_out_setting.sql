-- 10/12 (Nic) — THE RENT ROLL: WHO STAYS ON IT AFTER MOVING OUT, PER COMPANY
--
--   "who stays on the Rent Roll after moving out = LANDLORD'S CHOICE (a
--    setting on the page: billed in last 12 months / while they owe / all
--    time)."
--
-- Every household on an occupied space is always a row on the Rent Roll. This
-- is the company's choice of which households that MOVED OUT stay on it too:
--
--   billed_last_12_months  billed in the 12 months through the month picked —
--                          the page's only rule until 10/12, so the default
--   while_owing            while they still owe anything there
--   all_time               every household ever billed there
--
-- Values match RENT_ROLL_MOVED_OUT_RULES in packages/shared/src/rentRoll.ts.
-- The owner changes it on the Rent Roll (PUT /api/balances/rent-roll/moved-out);
-- every change is written to audit_log (keep everything). A page setting, not
-- money: landlords carries no journal trigger and needs none for this.
--
-- Expand-only, safe to apply before the code ships: the old code never reads
-- it, and the default is exactly what the page does today.
-- No backfill needed: every company starts on the default.
-- Safe drop: the column and its CHECK.

SET LOCAL lock_timeout = '10s';

ALTER TABLE landlords
  ADD COLUMN IF NOT EXISTS rent_roll_moved_out text NOT NULL DEFAULT 'billed_last_12_months';

ALTER TABLE landlords
  DROP CONSTRAINT IF EXISTS landlords_rent_roll_moved_out_check;
ALTER TABLE landlords
  ADD CONSTRAINT landlords_rent_roll_moved_out_check
    CHECK (rent_roll_moved_out IN ('billed_last_12_months', 'while_owing', 'all_time'));

COMMENT ON COLUMN landlords.rent_roll_moved_out IS
  '10/12 (Nic): which households that moved out stay on the Rent Roll — billed_last_12_months (default), while_owing, all_time. RENT_ROLL_MOVED_OUT_RULES.';
