-- S607 (Nic, DIRECTIVE): the dollar-divide model is an OPTION, never a rewrite.
--
-- Nic: "you're doing this specifically for Arizona, and we need to keep the
-- other functionality without changing it — if another state operates the way
-- that I have this currently set up, that they're still able to do it. We don't
-- wanna restrict how people bill. We want the full functionality where they can
-- operate in accordance with their state's laws, whatever that may be."
--
-- So the basis becomes a per-master SETTING rather than a platform-wide switch.
-- Arizona happens to require dollar recovery (A.R.S. § 33-2107(C)(1),
-- § 33-1314.01(B)); plenty of states let a landlord bill a published rate per
-- unit of usage, and that is what every existing master is doing today. Both
-- stay first-class.
--
--   usage_rate  — usage × the property's rate + base fee. The behaviour every
--                 master has now, and the DEFAULT, so this migration changes
--                 nothing for anyone until a landlord opts in.
--   bill_amount — the utility provider's actual dollar charge for the cycle is
--                 divided out. Blended rate = dollars ÷ usage, so the provider's
--                 service charge and taxes ride INSIDE the rate rather than
--                 appearing as a second line item on the tenant's bill.
--
-- Backfill is deliberately absent: every existing master keeps usage_rate. A
-- landlord moving to bill_amount is choosing a different legal posture and
-- should do it deliberately, from the meter's own setup card.

ALTER TABLE utility_meters
  ADD COLUMN IF NOT EXISTS rubs_basis text NOT NULL DEFAULT 'usage_rate';

ALTER TABLE utility_meters
  DROP CONSTRAINT IF EXISTS utility_meters_rubs_basis_check;
ALTER TABLE utility_meters
  ADD CONSTRAINT utility_meters_rubs_basis_check
  CHECK (rubs_basis = ANY (ARRAY['usage_rate'::text, 'bill_amount'::text]));

COMMENT ON COLUMN utility_meters.rubs_basis IS
  'S607: how a RUBS master prices its pool. usage_rate = usage × the property rate + base fee (default, unchanged behaviour, valid wherever a landlord may bill a published rate). bill_amount = divide the provider''s actual dollar bill for the cycle, blended into a single per-usage rate (required where the statute limits recovery to actual charges, e.g. A.R.S. § 33-2107(C)(1)). Ignored on non-RUBS meters.';
