-- S652: what a space IS, and what the park CALLS it, are two different facts.
--
-- Nic: "We need the system to distinguish unit type. Whatever they print on the
-- lease can be whatever. They can call it lot one on the lease, but it needs to
-- be mobile home one in the system so that we are accurately treating like unit
-- types the same consistency platform wide... The space is just the space. If
-- the home ever gets pulled out of there and gets converted to an RV space in
-- the back end, it's still going to be called lot one at that specific park.
-- People call them space one or lot one or whatever. The back end needs to
-- distinguish what the unit type actually is, not what the slang of it is."
--
-- And why it is not cosmetic: "if it was technically an RV spot and they called
-- it lot one, then it would be compatible on the scheduler to move around with
-- other short-term stay sites, versus a mobile home. You cannot put an RV in
-- there, which is why the distinction on the back end matters."
--
-- So `unit_number` stays the platform's own, built by canonicalUnitNumber from
-- the unit TYPE — MH 01, RV 07, STG 12 — and every screen, schedule and packet
-- that has to reason about what a space can hold keeps reading it. The park's
-- own word for the same space lives here and goes on the paper.
--
-- NULL means the park has no other word for it, and the canonical name prints.
-- A landlord who never thinks about this never sees it.

ALTER TABLE units
  ADD COLUMN IF NOT EXISTS display_label TEXT;

COMMENT ON COLUMN units.display_label IS
  'S652: what the park calls this space — "Lot 1", "Space 7". Printed on leases and shown to residents; NULL prints unit_number. NEVER used to decide what a space is or what may be put on it — unit_type does that.';

-- Country Acres is a mobile home park whose every document says "Lot". The
-- spaces are MH 01.. in the system and Lot 1.. on the page, which is the whole
-- point of the column.
UPDATE units u
   SET display_label = 'Lot ' || ltrim(regexp_replace(u.unit_number, '\D', '', 'g'), '0'),
       updated_at = NOW()
  FROM properties p
 WHERE p.id = u.property_id AND p.name ILIKE '%country acres%'
   AND u.unit_number ~ '^MH [0-9]+$';

-- Lot 0 would otherwise read "Lot " with nothing after it.
UPDATE units u SET display_label = 'Lot 0'
  FROM properties p
 WHERE p.id = u.property_id AND p.name ILIKE '%country acres%' AND u.unit_number = 'MH 00';
