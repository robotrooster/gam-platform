-- W-15 (final walkthrough, Nic decision S531): retire the direct_pay unit
-- status platform-wide. It marked "tenant pays the landlord outside the
-- platform" — an internal distinction the landlord never acts on (simplicity
-- rule), and it contradicts the locked S113 posture: GAM is electronic-only,
-- off-platform payments simply stay unpaid until the tenant converts to ACH.
-- Everywhere that consumed it (occupied-unit math, platform fee, rent roll)
-- treated it identically to 'active', so the merge is lossless.
--
-- Backfill: existing direct_pay rows become 'active' before the CHECK swap.

UPDATE units SET status = 'active' WHERE status = 'direct_pay';

ALTER TABLE units DROP CONSTRAINT units_status_check;
ALTER TABLE units ADD CONSTRAINT units_status_check
  CHECK (status = ANY (ARRAY['vacant'::text, 'available'::text, 'active'::text, 'delinquent'::text, 'suspended'::text]));
