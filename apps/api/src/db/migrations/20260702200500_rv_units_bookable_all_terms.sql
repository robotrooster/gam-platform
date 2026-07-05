-- S526 (Nic): every RV site is short-term AND long-term capable by default —
-- guests "often decide to just keep staying". New rv_spot units get this at
-- create (POST /units); this backfills the existing ones.
-- Backfill rationale: pre-launch data only; any landlord-narrowed allow-list
-- can be re-narrowed from the Master Schedule configure modal.
UPDATE units
   SET is_bookable = TRUE,
       lease_types_allowed = ARRAY['nightly','weekly','month_to_month','long_term']
 WHERE unit_type = 'rv_spot';
