-- S653 (Nic): "I had somebody they want a spot for the week of Thanksgiving,
-- but they didn't like the spot they were in last year... if there's a way to
-- have a preference, not only on a ideal site, but on a avoidance type
-- situation."
--
-- The sites this reservation must NOT be placed on. Sits beside the positive
-- requirements (required_site_layout / required_amp_service / locked_to_unit)
-- and is honored wherever those are: the nightly packer, extension relocation,
-- the available-sites list the counter reads from, and the create/move guards.
-- Unit ids, not numbers — numbers repeat across parks.
--
-- No backfill needed: empty = no avoided sites.
ALTER TABLE unit_bookings ADD COLUMN avoided_unit_ids uuid[] NOT NULL DEFAULT '{}';
COMMENT ON COLUMN unit_bookings.avoided_unit_ids IS 'S653: sites this guest asked not to be put on. Every placement path skips them.';
