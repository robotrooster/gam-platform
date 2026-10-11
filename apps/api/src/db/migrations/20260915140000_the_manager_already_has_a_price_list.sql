-- S646 — TAKE THE PASS-THROUGH BACK OUT.
--
-- Nic (S646, DIRECTIVE): "Take off the pass-through thing on that. The
-- pass-through should only be for the regular self-hosted landlords passing it
-- through to the tenants."
--
-- He is right, and the reason is that I built a second way to say something the
-- platform already says. His own description of what a manager does is:
--
--   "The property manager sets the percentage or flat rate or per-unit count,
--    that price. So the owner sees what the property manager sets on the
--    owner's statement. But the owner's statement would not see our contract
--    between the property manager and the platform."
--
-- That is pm_fee_plans, which has done percent-of-rent, flat-monthly and
-- per-unit since S108. A manager who wants to recover their software cost from
-- an owner raises their own fee — it is one number in their management
-- contract, not a line GAM invents on their behalf. Keeping a separate
-- "platform fee passed through" concept would have meant two places to set a
-- manager's price and two ways for a statement to disagree with a contract.
--
-- WHAT STAYS. GAM still bills the manager for a managed property, one bill
-- (platform_fee_accruals.billed_pm_company_id), still at the manager's own
-- negotiated rate (pm_company_platform_fee_overrides). Nic's other line holds:
-- "the owner's statement would not see our contract between the property
-- manager and the platform." Now it cannot, because there is nowhere to put it.
--
-- Both objects are empty — nothing was ever accrued into them — so this drops
-- no record of anything that happened.
DROP TABLE IF EXISTS pm_platform_fee_passthroughs;

ALTER TABLE pm_owner_relationships
  DROP COLUMN IF EXISTS platform_fee_billed_to,
  DROP COLUMN IF EXISTS platform_fee_rate_to_owner;
