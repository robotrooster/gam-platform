-- S309: properties.flexcharge_enabled — per-Location enablement gate
-- for FlexCharge (Business-Account-Owner-Extended Credit).
--
-- Closes the gap between the legal layer (Consumer ToS § 9.3 +
-- Business ToS § 11 + FlexCharge Business Account Agreement § 3,
-- shipped S308) and the operational code path. The legal layer
-- says FlexCharge is enabled per Location at the Business Account
-- Owner's discretion; before this migration, the schema and
-- service code had no per-Location gate — any property under any
-- landlord could be picked at flex_charge_accounts creation. This
-- column makes per-Location enablement real.
--
-- Default = FALSE (opt-in). New properties land disabled; the
-- landlord opts in per property from the property settings surface.
-- This mirrors the per-property posture of subleasing_allowed
-- (S247) and matches the FlexSuite portal-separation principle:
-- properties that don't offer FlexCharge never expose its
-- enrollment surfaces to Account Holders at that property.
--
-- Backfill: properties that already have at least one
-- flex_charge_accounts row are flipped to TRUE — those accounts
-- predate the gate and must continue to function. Properties with
-- zero existing FlexCharge accounts stay at the default FALSE.
-- The gate applies to NEW account creation only; existing accounts
-- on disabled properties continue to read/write their balance
-- normally.
--
-- Read posture: createFlexChargeAccount (services/flexCharge.ts)
-- gates on this column with a 403 when FALSE. Landlord-portal
-- FlexChargePage filters the create-account property dropdown to
-- enabled-only. Property edit form in PropertiesPage exposes the
-- toggle. Tenant-portal currently has no self-enrollment surface
-- to gate (statement view is read-only on existing accounts).

ALTER TABLE properties
  ADD COLUMN flexcharge_enabled BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN properties.flexcharge_enabled IS
  'S309: per-Location FlexCharge enablement gate. When FALSE (default), createFlexChargeAccount rejects new accounts at this property with a 403 and the landlord-side create UI hides the property from the dropdown. Existing flex_charge_accounts continue to function regardless of this flag — the gate applies to NEW account creation only.';

-- Backfill: keep existing FlexCharge accounts operational by
-- flipping any property that already hosts one to TRUE. New /
-- never-used properties stay at the default FALSE.
UPDATE properties p
   SET flexcharge_enabled = TRUE
 WHERE EXISTS (
   SELECT 1 FROM flex_charge_accounts fc WHERE fc.property_id = p.id
 );
