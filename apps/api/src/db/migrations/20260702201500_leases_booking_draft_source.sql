-- S526 (Nic): stays of 30+ days (7+ when the property runs weekly leases) get
-- a lease DRAFTED automatically from the reservation. The draft is a pending,
-- needs_review lease linked back to its booking:
--   * source_booking_id — idempotency (one draft per booking) + traceability
--   * lease_source gains 'booking_draft' alongside esigned/imported
-- No backfill needed (new capability).
ALTER TABLE leases ADD COLUMN IF NOT EXISTS source_booking_id uuid REFERENCES unit_bookings(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_leases_source_booking ON leases(source_booking_id) WHERE source_booking_id IS NOT NULL;

ALTER TABLE leases DROP CONSTRAINT IF EXISTS leases_lease_source_check;
ALTER TABLE leases ADD CONSTRAINT leases_lease_source_check
  CHECK (lease_source = ANY (ARRAY['esigned'::text, 'imported'::text, 'booking_draft'::text]));
