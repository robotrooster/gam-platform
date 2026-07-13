-- S537 (Nic): explicit per-(property, unit_type) late-fee DECISIONS.
--
-- Why: under S535, "no policy row = that unit class has no late fee",
-- which makes UNCONFIGURED indistinguishable from DELIBERATELY-NO-FEE.
-- Consistency rule locked this session: a landlord must make an explicit
-- late-fee decision for a unit class before units of that class can be
-- added or tenants onboarded to them (anti-discrimination: identical,
-- vetted terms for every tenant of a class — never per-tenant values).
-- A row now means "decided": either concrete fee terms, or an explicit
-- "no late fee for this class" (no_late_fee = TRUE).
--
-- Backfill: every (property, unit_type) combo that already has units but
-- no policy row gets a grandfathered decision so existing operations are
-- not bricked by the new gate. The grandfathered decision mirrors the
-- property-level legacy late_fee_* columns (the landlord's declared
-- policy before S535 moved policy to per-unit-type rows): fee terms when
-- the property master toggle is on, an explicit no-fee decision when off.
-- Pre-launch, demo data only — no live billing is affected by backfill.

ALTER TABLE property_unit_type_late_fees
  ADD COLUMN no_late_fee boolean NOT NULL DEFAULT false;

-- Fee columns become nullable so a no-fee decision row carries no values.
ALTER TABLE property_unit_type_late_fees
  ALTER COLUMN late_fee_grace_days DROP NOT NULL,
  ALTER COLUMN late_fee_grace_days DROP DEFAULT,
  ALTER COLUMN late_fee_initial_amount DROP NOT NULL,
  ALTER COLUMN late_fee_initial_type DROP NOT NULL;

-- A row is either a concrete fee decision (all core fields present) or an
-- explicit no-fee decision (all fee fields empty). Nothing in between.
ALTER TABLE property_unit_type_late_fees
  ADD CONSTRAINT put_late_fees_decision_shape CHECK (
    (no_late_fee = TRUE
      AND late_fee_grace_days     IS NULL
      AND late_fee_initial_amount IS NULL
      AND late_fee_initial_type   IS NULL
      AND late_fee_accrual_amount IS NULL
      AND late_fee_cap_amount     IS NULL)
    OR
    (no_late_fee = FALSE
      AND late_fee_grace_days     IS NOT NULL
      AND late_fee_initial_amount IS NOT NULL
      AND late_fee_initial_type   IS NOT NULL)
  );

-- Grandfather every (property, unit_type) combo that already has units.
INSERT INTO property_unit_type_late_fees
  (property_id, unit_type, no_late_fee,
   late_fee_grace_days, late_fee_initial_amount, late_fee_initial_type,
   late_fee_accrual_amount, late_fee_accrual_type, late_fee_accrual_period,
   late_fee_cap_amount, late_fee_cap_type)
SELECT DISTINCT
  u.property_id,
  u.unit_type,
  NOT (p.late_fee_enabled AND p.late_fee_initial_amount IS NOT NULL),
  CASE WHEN p.late_fee_enabled AND p.late_fee_initial_amount IS NOT NULL THEN p.late_fee_grace_days END,
  CASE WHEN p.late_fee_enabled AND p.late_fee_initial_amount IS NOT NULL THEN p.late_fee_initial_amount END,
  CASE WHEN p.late_fee_enabled AND p.late_fee_initial_amount IS NOT NULL THEN p.late_fee_initial_type END,
  CASE WHEN p.late_fee_enabled AND p.late_fee_initial_amount IS NOT NULL THEN p.late_fee_accrual_amount END,
  CASE WHEN p.late_fee_enabled AND p.late_fee_initial_amount IS NOT NULL THEN p.late_fee_accrual_type END,
  CASE WHEN p.late_fee_enabled AND p.late_fee_initial_amount IS NOT NULL THEN p.late_fee_accrual_period END,
  CASE WHEN p.late_fee_enabled AND p.late_fee_initial_amount IS NOT NULL THEN p.late_fee_cap_amount END,
  CASE WHEN p.late_fee_enabled AND p.late_fee_initial_amount IS NOT NULL THEN p.late_fee_cap_type END
FROM units u
JOIN properties p ON p.id = u.property_id
WHERE u.unit_type IS NOT NULL
ON CONFLICT (property_id, unit_type) DO NOTHING;
