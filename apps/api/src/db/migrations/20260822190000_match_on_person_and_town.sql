-- S616 (Nic) — the match is the PERSON and the TOWN, not a typed address.
--
--   "Whatever the first landlord uses to mark the utilities, whatever I'm gonna
--    name my next door neighbor's thing as, should be irrelevant to the matchup.
--    We don't necessarily know the exact physical address of the place next
--    door... a landlord may not want to put that in, or put it incorrectly. If
--    it's a multiunit building they're not gonna know which unit it is. So we
--    need to make that not gated on getting it right.
--
--    It really should just come down to the second landlord, if they ever
--    onboard, getting all active people on the lease — and that will be the
--    thing that matches it. Same person, proximity of the same nearby address.
--    It could be next door but the address could be way different, because it
--    could be a corner lot facing on the other street.
--
--    So we just need to look at: one, match it to the name; two, match it to the
--    same town; three, match it to them already having a user profile."
--
-- The previous version gated on the utility landlord typing the neighbour's
-- street address closely enough to match the other landlord's. That is the one
-- field in the whole comparison NOBODY IS SURE OF — it describes somebody
-- else's building — and a corner lot legitimately carries an address on a
-- different street entirely. Gating on it meant the feature failed precisely
-- where the landlord was least certain.
--
-- What IS reliable is what each landlord entered about THEIR OWN property, and
-- who the person is. So the address test drops to the town, and the person
-- carries the weight: the same human being pays utilities to one landlord and
-- rents from another. A street-level agreement is still RECORDED when it
-- happens, because it is worth having in the audit trail — it just no longer
-- decides anything.
ALTER TABLE cross_property_service_links
  DROP CONSTRAINT IF EXISTS cross_property_service_links_address_match_basis_check;
ALTER TABLE cross_property_service_links
  ADD CONSTRAINT cross_property_service_links_address_match_basis_check
  CHECK (address_match_basis IN ('same_address','same_street','same_town','none'));

COMMENT ON COLUMN cross_property_service_links.address_match_basis IS
  'S616: how closely the two addresses agreed — ''same_address'' and '
  '''same_street'' are recorded when the typed service address happens to line '
  'up, but ''same_town'' is all that is REQUIRED. The deciding signal is the '
  'person: the same tenant pays one landlord for utilities and the other for '
  'rent.';
