-- S640 — an emergency contact has to be reachable, and has to say where it came from.
--
-- Nic: "I want to do a build on an emergency contact table... one lady, Carine
-- Covarrubius, has her daughter, Irma, as an emergency contact. She didn't put
-- the phone number down. Irma is also a tenant... Can you merge or pull the
-- applicable data from different sources to get a complete table?"
--
-- Thirty-three of these sit in signed leases as free text. Parsed: 13 carry a
-- name and a number, 11 a name with nobody to ring, 4 a number with no name,
-- and 5 are not contacts at all ("NA", "Wife", "911").
--
-- The columns below are what makes that usable at a front desk:
--   * name becomes NULLABLE — a lease that says only "5208414602" is still
--     worth keeping, and pretending it names somebody would be a lie.
--   * raw_text keeps what the lease actually said, always. The parse is an
--     interpretation; the original is evidence.
--   * source says who put it there, so staff know whether they are looking at
--     something a resident wrote or something we inferred.
--   * confirmed_at is the annual re-check Nic asked for: "maybe once a year, we
--     make sure it's still relevant."
ALTER TABLE emergency_contacts
  ALTER COLUMN name DROP NOT NULL;

ALTER TABLE emergency_contacts
  ADD COLUMN IF NOT EXISTS raw_text            text,
  ADD COLUMN IF NOT EXISTS source              text NOT NULL DEFAULT 'staff',
  ADD COLUMN IF NOT EXISTS source_field_id     uuid REFERENCES lease_document_fields(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS confirmed_at        timestamptz,
  ADD COLUMN IF NOT EXISTS confirmed_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE emergency_contacts
  DROP CONSTRAINT IF EXISTS emergency_contacts_source_check;
ALTER TABLE emergency_contacts
  ADD CONSTRAINT emergency_contacts_source_check
  CHECK (source IN ('lease', 'staff', 'tenant', 'parser'));

-- One row per lease field, so re-running the import corrects rather than
-- duplicates. A contact somebody typed at the counter has no field id and is
-- not touched by it.
CREATE UNIQUE INDEX IF NOT EXISTS emergency_contacts_source_field_uniq
  ON emergency_contacts (source_field_id)
  WHERE source_field_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS emergency_contacts_tenant_idx
  ON emergency_contacts (tenant_id);

-- A row has to be SOMETHING: a name, a number, or the original text we are
-- keeping so the desk can see what the lease said before asking again.
ALTER TABLE emergency_contacts
  DROP CONSTRAINT IF EXISTS emergency_contacts_not_empty;
ALTER TABLE emergency_contacts
  ADD CONSTRAINT emergency_contacts_not_empty
  CHECK (name IS NOT NULL OR phone IS NOT NULL OR raw_text IS NOT NULL);

COMMENT ON COLUMN emergency_contacts.raw_text IS
  'S640: what the lease field said, verbatim. The parse is an interpretation; this is the evidence.';
COMMENT ON COLUMN emergency_contacts.confirmed_at IS
  'S640: last time a person confirmed this is still current. Drives the annual re-check.';
