-- Defragment the two public acquisition channels (S593).
--
-- WHY: the short-term booking storefront already funnels into occupancy — a
-- long stay auto-drafts a lease (leases.source_booking_id). The long-term
-- listings marketplace dead-ended at "application + landlord contact." This
-- adds the mirror linkage so an approved application can auto-draft a lease and
-- converge on the SAME Master Schedule the bookings do. One occupancy source of
-- truth, multiple acquisition doors.
--
-- Mirrors the source_booking_id shape exactly: nullable FK (ON DELETE SET NULL
-- so deleting an application never destroys a real lease) + a unique partial
-- index so an application drafts at most one lease (idempotency backstop).

ALTER TABLE leases
  ADD COLUMN IF NOT EXISTS source_application_id uuid
    REFERENCES unit_applications(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_leases_source_application
  ON leases (source_application_id) WHERE (source_application_id IS NOT NULL);

-- Extend the lease_source vocabulary. The old CHECK allowed
-- ('esigned','imported','booking_draft'); add 'application_draft' for a lease
-- drafted from a listings-marketplace application. Fix-forward: drop + re-add
-- (never edit the applied migration that created it).
ALTER TABLE leases DROP CONSTRAINT IF EXISTS leases_lease_source_check;
ALTER TABLE leases ADD CONSTRAINT leases_lease_source_check
  CHECK (lease_source = ANY (ARRAY['esigned','imported','booking_draft','application_draft']));
