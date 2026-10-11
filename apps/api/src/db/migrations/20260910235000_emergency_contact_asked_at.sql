-- S640 — record that we asked, so a household hears from us once a year.
--
-- Nic: "maybe make a thing where we can ping tenants to update an emergency
-- contact — maybe once a year, we make sure it's still relevant."
--
-- confirmed_at (S640, earlier tonight) says when somebody last told us it is
-- right. asked_at says when we last raised it. Both are needed: without
-- asked_at, a resident with nothing on file would be asked every time the job
-- runs, which is exactly how the signing reminders sent 952 emails to 39 people.
ALTER TABLE emergency_contacts
  ADD COLUMN IF NOT EXISTS asked_at timestamptz;

-- A row that exists ONLY to record that we asked is legitimate — it is how a
-- resident with nothing on file stops being asked nightly. The constraint
-- predates that and would have rejected it.
ALTER TABLE emergency_contacts
  DROP CONSTRAINT IF EXISTS emergency_contacts_not_empty;
ALTER TABLE emergency_contacts
  ADD CONSTRAINT emergency_contacts_not_empty
  CHECK (name IS NOT NULL OR phone IS NOT NULL OR raw_text IS NOT NULL OR asked_at IS NOT NULL);

COMMENT ON COLUMN emergency_contacts.asked_at IS
  'S640: when we last asked this resident to confirm or supply a contact. Distinct from confirmed_at, which is when they last answered.';
