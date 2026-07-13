-- S538 — STR pricing (Nic-locked S536).
--
-- WHY: short-term-rental houses/apartments compete with Airbnb (~16% take).
-- GAM's model for them is a small percentage of booking revenue (~5%)
-- instead of the $2 x CEIL(nights/30) billable-unit aggregation. RV spots
-- (and every other unit type) KEEP the 30-night aggregation — the
-- percentage fee applies ONLY to short-stay bookings on units typed
-- apartment / single_family (shared STR_FEE_UNIT_TYPES).
--
-- str_fee_pct rides the same config -> landlord-override cascade as
-- rate_per_unit / min_per_property. The STR fee folds under the existing
-- per-property monthly minimum: total = MAX(rate*billable + str_fee, min).
--
-- No backfill needed: historical accrual rows predate the model and the
-- new columns default to 0 / 0.05; past months are never re-billed
-- (accrual job is idempotent per (landlord, property, month)).

ALTER TABLE platform_fee_config
  ADD COLUMN str_fee_pct numeric(5,4) NOT NULL DEFAULT 0.05;

ALTER TABLE landlord_platform_fee_overrides
  ADD COLUMN str_fee_pct numeric(5,4);

ALTER TABLE platform_fee_accruals
  ADD COLUMN str_revenue    numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN str_fee_amount numeric(10,2) NOT NULL DEFAULT 0;
