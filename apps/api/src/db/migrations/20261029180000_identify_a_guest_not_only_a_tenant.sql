-- 10/29 (Nic): a short-stay guest has to be identifiable, because that is who
-- the left-owing flag has to recognise at the next park.
--
--   "A lot of parks will take a copy of the driver's license for, in case
--    something happens, they have a record of who was actually there. They
--    don't run a full background check, but they at least know who the person
--    was... we need a way in real time, somebody just paying for a night. The
--    system has to know this person has the same name, and it either is or
--    isn't the actual same person that owes this other debt somewhere else."
--
-- tenant_identifications already holds everything wanted — id type, number,
-- issuing state, expiry, and a scan of the document — and is tied to a
-- `tenants` row by a NOT NULL column. A weekly guest has no tenants row, which
-- is the same gap the debts themselves had until this morning: the person is
-- in the system (every booking carries a name, most carry a phone) but the
-- table insisted on a kind of record they do not have.
--
-- So an identification now belongs to EITHER a tenant or a booking, exactly
-- one of the two. Nothing is dropped and nothing is rewritten: the table has
-- no rows and one writer (the lease-parser intent flow), which keeps passing a
-- tenant.
--
-- The birthday is the other half. Name alone cannot tell two people apart, and
-- a licence can be reissued in another state with a new number — his words:
-- "even if they get a new license in a different state, if we have a name
-- matching a birthday... there's enough points of contact". tenants and users
-- carry date_of_birth already; a guest had nowhere to put one.
--
-- No backfill needed: no identification exists, and a booking with no birthday
-- is simply a booking nobody typed one into.

ALTER TABLE tenant_identifications ALTER COLUMN tenant_id DROP NOT NULL;
ALTER TABLE tenant_identifications
  ADD COLUMN IF NOT EXISTS booking_id UUID REFERENCES unit_bookings(id) ON DELETE CASCADE,
  -- Who typed or scanned it, and which it was. A scan is the stronger record:
  -- two scans of the same licence agree exactly, where two typists do not.
  ADD COLUMN IF NOT EXISTS captured_how TEXT NOT NULL DEFAULT 'typed',
  ADD COLUMN IF NOT EXISTS date_of_birth DATE,
  ADD COLUMN IF NOT EXISTS captured_by UUID REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE tenant_identifications
  DROP CONSTRAINT IF EXISTS tenant_identifications_one_anchor;
ALTER TABLE tenant_identifications
  ADD CONSTRAINT tenant_identifications_one_anchor
  CHECK ((tenant_id IS NOT NULL) <> (booking_id IS NOT NULL));

ALTER TABLE tenant_identifications
  DROP CONSTRAINT IF EXISTS tenant_identifications_captured_how_check;
ALTER TABLE tenant_identifications
  ADD CONSTRAINT tenant_identifications_captured_how_check
  CHECK (captured_how = ANY (ARRAY['scanned'::text, 'typed'::text]));

CREATE INDEX IF NOT EXISTS idx_tenant_identifications_booking
  ON tenant_identifications (booking_id) WHERE booking_id IS NOT NULL;
-- What the matcher reaches for: the same licence number at another park is the
-- strongest single point there is.
CREATE INDEX IF NOT EXISTS idx_tenant_identifications_number
  ON tenant_identifications (upper(btrim(id_number)), issuing_country);

-- A guest's birthday, where a booking is all we have of them.
ALTER TABLE unit_bookings ADD COLUMN IF NOT EXISTS guest_date_of_birth DATE;

COMMENT ON COLUMN tenant_identifications.booking_id IS
  '10/29: the stay this ID was taken for, when the person has no tenants row — a nightly or weekly guest. Exactly one of tenant_id / booking_id is set.';
COMMENT ON COLUMN tenant_identifications.captured_how IS
  '10/29: scanned (a photo of the document is on file, document_url) or typed by hand at the desk. A scan is the stronger record — two scans of one licence agree exactly.';
COMMENT ON COLUMN unit_bookings.guest_date_of_birth IS
  '10/29: the guest''s birthday, for telling two people of the same name apart when matching a left-owing balance. Nothing requires it.';
