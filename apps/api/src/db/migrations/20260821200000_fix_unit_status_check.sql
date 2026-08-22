-- S614 FIX: 20260821180000 rewrote units_status_check from memory and dropped
-- 'available', so marking a unit available started failing with a constraint
-- error. The authoritative list is UNIT_STATUSES in packages/shared, plus the
-- new 'utility_service'. Restated in full here rather than patched.
ALTER TABLE units DROP CONSTRAINT IF EXISTS units_status_check;
ALTER TABLE units ADD CONSTRAINT units_status_check
  CHECK (status = ANY (ARRAY[
    'vacant','available','active','delinquent','suspended','owner_use','utility_service']));
