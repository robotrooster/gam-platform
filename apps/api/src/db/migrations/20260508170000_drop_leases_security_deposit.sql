-- S196: phase 2 of leases.security_deposit → lease_fees deprecation.
--
-- S195 added 'security_deposit' as a valid lease_fees fee_type,
-- backfilled existing values, and dual-wrote at every writer site.
-- This migration drops the legacy column. After this point,
-- lease_fees is the sole source of truth for the per-lease
-- security deposit amount.
--
-- Reader cutover and writer simplification ship in the same session
-- as this migration (services/depositReturn.ts, routes/reports.ts,
-- routes/tenants.ts /me, the four inline INSERT/UPDATE statements
-- across esign / leases / landlords / leaseParser, the
-- WRITABLE_LEASE_COLUMN_SPECS entry in @gam/shared, and the
-- moveInBundle.ts MoveInInputs interface).
--
-- Idempotency: column may not exist if this migration is replayed
-- against a partially-migrated DB. The IF EXISTS guard handles that.

ALTER TABLE leases DROP COLUMN IF EXISTS security_deposit;
