-- S630 DIRECTIVE (Nic): "It's ten dollars per Connect account. So if several
-- properties deposit to the same Stripe account, it's only ten dollar minimum
-- for that setup."
--
-- The minimum was charged PER PROPERTY. A landlord with four parks paying into
-- one Stripe Connect account was billed four minimums for one payout setup —
-- which is what the minimum is actually for. It is a floor on the SETUP, not on
-- each address.
--
-- Renamed rather than redefined in place: a column called min_per_property that
-- means "per Connect account" is exactly the kind of thing that gets misread by
-- the next person to touch billing.
ALTER TABLE platform_fee_config
  RENAME COLUMN min_per_property TO min_per_connect_account;
ALTER TABLE landlord_platform_fee_overrides
  RENAME COLUMN min_per_property TO min_per_connect_account;
ALTER TABLE platform_fee_accruals
  RENAME COLUMN min_per_property TO min_per_connect_account;

-- The shortfall added to reach the group's minimum, kept apart from the row's
-- own earned fee so a ledger reads "fee $8 + minimum top-up $2" rather than a
-- $10 that cannot be explained from the unit count.
ALTER TABLE platform_fee_accruals
  ADD COLUMN IF NOT EXISTS connect_min_topup numeric(12,2) NOT NULL DEFAULT 0;

-- Which payout setup this row was pooled under when the minimum was applied.
-- Recorded because a landlord can move a property to a different Connect
-- account later, and a past month must still explain itself.
ALTER TABLE platform_fee_accruals
  ADD COLUMN IF NOT EXISTS connect_group_key text;

COMMENT ON COLUMN platform_fee_config.min_per_connect_account IS
  'Monthly floor per Stripe Connect payout account, NOT per property. Properties sharing one Connect account share one minimum.';
COMMENT ON COLUMN platform_fee_accruals.connect_min_topup IS
  'Shortfall added to this row to bring its Connect-account group up to the monthly minimum. Zero when the group already cleared it.';
