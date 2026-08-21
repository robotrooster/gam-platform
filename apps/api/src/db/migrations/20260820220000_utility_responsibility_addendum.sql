-- S613 (Nic, DIRECTIVE — narrows a rule I had been applying too broadly):
--
--   "We are billing the rent, security deposit, pet deposits, things like that
--    in the lease. Trash or other stuff may be an ADDENDUM when billed back
--    separately, as things change. There needs to be able to be other charges
--    that are not on the lease. The accuracy we're going for is that the things
--    that are IN the lease — the legal document — cannot be ALTERED on the
--    charge, not that no other charges happen. We can't have a landlord saying
--    the tenant signed the lease for eight hundred dollars and trying to charge
--    them nine hundred."
--
-- The rule was being read as "a tenant is only ever charged what the signed
-- lease lists", so lease_utility_responsibilities — written once at e-sign from
-- the lease's own tags, with no other writer anywhere — became an absolute gate.
-- A landlord who started trash service in year two had no way to bill it: the
-- meter, the assignment and the rate could all be right and the run would report
-- unitsSkipped forever.
--
-- The real rule is narrower and sharper. What the lease FIXES cannot move: rent,
-- deposits, the terms someone signed. What the lease is SILENT about can be
-- added, the way an addendum adds it on paper.
--
-- So responsibility becomes settable after signing, and carries WHO set it and
-- WHEN. GAM cannot verify an addendum exists — it can make the change a matter
-- of record instead of a matter of trust, which is the same posture as every
-- other after-the-fact change here. Rent and deposits are untouched by this:
-- they come off the lease row and there is still no door to edit them.
ALTER TABLE lease_utility_responsibilities
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'lease'
    CHECK (source IN ('lease', 'addendum')),
  ADD COLUMN IF NOT EXISTS set_by_user_id uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS set_at timestamptz,
  ADD COLUMN IF NOT EXISTS note text;

COMMENT ON COLUMN lease_utility_responsibilities.source IS
  'S613: ''lease'' = parsed from the signed document at e-sign. ''addendum'' = '
  'added later by the landlord, who is asserting there is paper for it.';

-- Everything already recorded came from a signed lease, by definition: e-sign
-- was the only writer that existed.
UPDATE lease_utility_responsibilities SET source = 'lease' WHERE source IS NULL;
