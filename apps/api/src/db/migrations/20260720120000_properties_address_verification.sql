-- S550 (Nic): real-world address verification at property creation. Two
-- graded signals, strongest wins:
--   'parcel'    — the street number + street corroborate against county
--                 parcel records (gam_properties; AZ statewide today).
--                 County situs data is messy (the real Oak Park's situs
--                 city is wrong in Yavapai's feed), so parcel NO-match
--                 never blocks — it just can't upgrade confidence.
--   'geocoded'  — the address resolves to coordinates (Nominatim). Catches
--                 fake cities/states and nonsense addresses.
--   'unverified'— neither worked. Property still creates (rural addresses
--                 legitimately fail both), but an admin alert fires so no
--                 unverifiable address enters the platform silently.
-- lat/lon stored when geocoded (also future map/routing use).
-- No backfill needed: existing rows stay 'unverified'; a sweep can verify
-- them later.

ALTER TABLE properties
  ADD COLUMN latitude  numeric(9,6),
  ADD COLUMN longitude numeric(9,6),
  ADD COLUMN address_verification text NOT NULL DEFAULT 'unverified'
    CHECK (address_verification IN ('unverified', 'geocoded', 'parcel')),
  ADD COLUMN address_verified_at timestamptz;
