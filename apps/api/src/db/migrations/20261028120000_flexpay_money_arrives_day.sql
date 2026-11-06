-- 10/26 (Nic) — WE ASK WHEN THEIR MONEY ARRIVES, NOT WHEN THEY WANT TO PAY.
--
--   "We don't ask them when they want to pay. If they get paid on the second
--    Wednesday, they cannot choose the third Wednesday just for the heck of
--    it."
--
-- Today `flexpay_pull_day` is a free choice of any day from the 6th to the
-- 28th, which lets somebody sit in a cheaper Wednesday column than their
-- benefit actually lands in — GAM's money would be out longer than the price
-- assumes, and the resident would have picked that on purpose.
--
-- So the answer they give is stored HERE, and the pull day is DERIVED from it.
-- Two columns rather than one because they are different facts: this is when
-- their money lands (theirs, and not ours to move), and flexpay_pull_day is
-- when GAM draws (derived, and the engine's). Keeping only the derived day
-- would lose the reason it is what it is.
--
-- The Wednesday windows are exact (packages/shared benefitWednesdayForPullDay):
-- the 2nd Wednesday is always the 8th-14th, the 3rd the 15th-21st, the 4th the
-- 22nd-28th. So a day of the month IS the column, with no guessing.
--
-- 1-28 only: the 29th-31st do not exist every month.
--
-- NO BACKFILL. An existing enrollment keeps the pull day it has; this stays
-- NULL for them, which reads correctly as "we never asked". Asking them is a
-- product decision, not a migration's to make.

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS flexpay_money_arrives_day integer,
  ADD COLUMN IF NOT EXISTS flexpay_money_arrives_answered_at timestamptz;

ALTER TABLE public.tenants
  DROP CONSTRAINT IF EXISTS tenants_flexpay_money_arrives_day_check;
ALTER TABLE public.tenants
  ADD CONSTRAINT tenants_flexpay_money_arrives_day_check
  CHECK (flexpay_money_arrives_day IS NULL
         OR (flexpay_money_arrives_day BETWEEN 1 AND 28));

-- An answer is stamped with when it was given, so "they told us" can never be
-- inferred from a day that was written by something else.
ALTER TABLE public.tenants
  DROP CONSTRAINT IF EXISTS tenants_flexpay_money_arrives_stamped;
ALTER TABLE public.tenants
  ADD CONSTRAINT tenants_flexpay_money_arrives_stamped
  CHECK ((flexpay_money_arrives_day IS NULL) = (flexpay_money_arrives_answered_at IS NULL));

COMMENT ON COLUMN public.tenants.flexpay_money_arrives_day IS
  '10/26 (Nic): the day of the month the resident says their money lands. '
  'The FlexPay pull day and the benefit-Wednesday price column are DERIVED '
  'from it — "We don''t ask them when they want to pay." NULL means nobody '
  'has asked them yet.';
