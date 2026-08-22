-- S616 CORRECTION to 20260822090000, before it was ever used.
--
-- That table recorded the evidence for a proposed link as PROXIMITY IN METRES,
-- derived from properties.latitude/longitude. Nic, on seeing it:
--
--   "Don't use the Arizona parcel data. We have no way to know if two landlords
--    next to each other in a completely different state are gonna onboard
--    tomorrow. It can't be gated on data that we don't have everywhere else
--    yet. It needs to be address matched, not parcel matched."
--
-- The coordinates were geocoder-derived rather than parcel-derived, so the
-- letter of the objection missed — but the substance lands hard. HALF the
-- properties in the database have no coordinates at all, because a geocoder
-- that cannot place a rural address leaves them NULL, and Oak Park is exactly
-- that kind of address. Evidence that is absent for half the platform is not
-- evidence; it is a feature that silently does not work.
--
-- What replaces it costs nothing to obtain and works in every state: the
-- ADDRESS the utility landlord already typed for the space he serves, compared
-- against the address the other landlord types for his own property. Two people
-- describing one physical place, independently. Pure text, no external corpus,
-- no coordinates.
ALTER TABLE cross_property_service_links
  DROP COLUMN IF EXISTS proximity_meters,
  DROP COLUMN IF EXISTS proximity_checked_at;

ALTER TABLE cross_property_service_links
  ADD COLUMN IF NOT EXISTS address_match_basis text
    CHECK (address_match_basis IN ('same_address','same_street','none')),
  ADD COLUMN IF NOT EXISTS address_match_evidence text,
  ADD COLUMN IF NOT EXISTS address_checked_at timestamptz;

COMMENT ON COLUMN cross_property_service_links.address_match_basis IS
  'S616: how the two addresses corroborated — ''same_address'' (the service '
  'address the utility landlord typed IS the other landlord''s property '
  'address), ''same_street'' (same street and postcode, numbers close), or '
  '''none'' (a person proposed it; GAM could not tell).';
COMMENT ON COLUMN cross_property_service_links.address_match_evidence IS
  'S616: the plain-language reason, snapshotted at proposal time and shown on '
  'all three approval screens. The people consenting see WHY GAM thinks these '
  'are one place rather than being asked to trust a match.';
