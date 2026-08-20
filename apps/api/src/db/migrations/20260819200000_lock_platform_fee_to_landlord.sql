-- S607 (Nic, DIRECTIVE): the platform fee is ALWAYS the landlord's. Not a toggle.
--
-- Nic: "The platform fee is always a landlord cost... the landlord cannot toggle
-- the platform fee because when we change for volume discounts or things like
-- that, that needs to not affect what the tenants are paying. That needs to stay
-- isolated for sure."
--
-- The reasoning is structural, not preference. GAM's per-unit rate moves for
-- reasons that have nothing to do with any tenant: negotiated volume discounts,
-- superadmin per-landlord overrides, future repricing. If that rate could reach
-- a tenant's bill, then a discount GAM grants a large landlord would silently
-- change what that landlord's tenants pay in rent-adjacent charges — GAM's
-- commercial terms leaking onto a consumer's bill. Locking the payer keeps the
-- platform fee entirely inside the GAM↔landlord relationship, where it belongs.
--
-- Mirrors the S513 card lock, which pins card_fee_payer to 'tenant' for the
-- opposite-but-equivalent reason. Two of the four rails are now fixed by policy
-- and two are the landlord's to choose:
--
--     ach_fee_payer     — landlord's choice (default tenant)
--     manual_fee_payer  — landlord's choice (default tenant)   [S607]
--     card_fee_payer    — LOCKED to 'tenant'                   [S513]
--     platform_fee_payer— LOCKED to 'landlord'                 [S607, here]
--
-- Enforced in the DATABASE rather than only in the routes, because a CHECK is
-- the one place a future route, script or manual UPDATE cannot quietly bypass.
--
-- Backfill: every live row is already 'landlord' (verified before writing this)
-- and every platform_fee_accruals row already carries payer='landlord', so the
-- UPDATE below is a no-op today and exists only to make the constraint safe to
-- add on any environment that drifted.

UPDATE property_allocation_rules
   SET platform_fee_payer = 'landlord'
 WHERE platform_fee_payer <> 'landlord';

ALTER TABLE property_allocation_rules
  ALTER COLUMN platform_fee_payer SET DEFAULT 'landlord';

ALTER TABLE property_allocation_rules
  DROP CONSTRAINT IF EXISTS property_allocation_rules_platform_fee_payer_check;
ALTER TABLE property_allocation_rules
  ADD CONSTRAINT property_allocation_rules_platform_fee_payer_check
  CHECK (platform_fee_payer = 'landlord');

COMMENT ON COLUMN property_allocation_rules.platform_fee_payer IS
  'S607: LOCKED to landlord. The platform fee is GAM''s commercial relationship with the landlord and must never reach a tenant''s bill — otherwise a volume discount GAM grants a landlord would change what that landlord''s tenants pay. Column retained (rather than dropped) because platform_fee_accruals.payer snapshots it per accrual.';
