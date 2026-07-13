-- S538 — storage short-stay lock (Nic-locked).
--
-- WHY: storage units can NEVER be short-term bookable — no nightly/weekly
-- bookings, no public booking page. The API now enforces this at unit
-- create, unit type config, manual reservation create, and the public
-- bookStay flow (shared SHORT_STAY_LOCKED_UNIT_TYPES). This migration is
-- the data-side cleanup: any storage unit created before the lock (the
-- old create path granted nightly/weekly to every non-RV type) gets its
-- allow-list stripped and its public-bookable flag cleared.
--
-- Backfill: yes (the two UPDATEs below); idempotent; no schema change.

UPDATE units
   SET lease_types_allowed = ARRAY(
         SELECT t FROM unnest(lease_types_allowed) AS t
          WHERE t NOT IN ('nightly', 'weekly')),
       updated_at = NOW()
 WHERE unit_type = 'storage'
   AND lease_types_allowed && ARRAY['nightly', 'weekly']::text[];

UPDATE units
   SET is_bookable = FALSE,
       updated_at = NOW()
 WHERE unit_type = 'storage'
   AND is_bookable = TRUE;
