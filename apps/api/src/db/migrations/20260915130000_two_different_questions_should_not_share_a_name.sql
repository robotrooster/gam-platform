-- S645 — RENAME, because two different questions were sharing a column name.
--
-- I added `platform_fee_payer` to pm_owner_relationships and the deploy gate
-- refused it. The guard in routes/payments.test.ts asserts that
-- `platform_fee_payer` lives in exactly ONE table, property_allocation_rules,
-- keyed by property — it exists so a fee setting can never be made per-tenant
-- or per-lease, which is how you end up singling out one resident.
--
-- The guard was right, and not only on a technicality. Those are two unrelated
-- questions that happened to get the same words:
--
--   property_allocation_rules.platform_fee_payer  — landlord or tenant, i.e.
--       who BEARS the cost. Locked to the landlord since S607.
--   pm_owner_relationships.<this column>          — the manager or the owner,
--       i.e. who GAM sends the INVOICE to, and whether the manager re-bills.
--
-- Anyone reading the same name in two tables would reasonably assume the same
-- enum, and they would be wrong in a way that touches money. So this one is
-- named for what it actually decides: where the bill goes.
ALTER TABLE pm_owner_relationships
  RENAME COLUMN platform_fee_payer TO platform_fee_billed_to;

-- The CHECK travels with the column; renaming it too so the constraint's name
-- does not lie about which column it guards.
ALTER TABLE pm_owner_relationships
  RENAME CONSTRAINT pm_owner_relationships_platform_fee_payer_check
                 TO pm_owner_relationships_platform_fee_billed_to_check;
