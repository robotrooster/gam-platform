-- Drop vestigial pm-era columns from landlords.
-- Background check pricing is now GAM-set (Checkr partnership), not
-- landlord-configurable. Columns were never wired to the live background
-- check flow — only the PATCH /api/landlords/me endpoint wrote them.
-- See PERMISSIONS_AUDIT.md / DEFERRED.md item 20.

ALTER TABLE landlords DROP COLUMN IF EXISTS bg_check_fee;
ALTER TABLE landlords DROP COLUMN IF EXISTS bg_check_fee_min;
