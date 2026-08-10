-- S602: personalization content for the public booking site.
--
-- booking_intro is a short hero welcome line. Landlords also want to tell their
-- STORY (who they are, family-owned, how long they've run the place) and
-- describe the LOCAL AREA / things to do nearby — so a browsing guest gets a
-- feel for the place, not just a price and a Book button. Two free-text sections,
-- rendered on the property's subdomain site and surfaced to the property agent
-- (Skye) so she can talk about them too.
--
-- Nullable free text; no backfill needed (existing sites simply omit the
-- sections until the landlord fills them in).

ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS booking_about text,
  ADD COLUMN IF NOT EXISTS booking_area  text;

COMMENT ON COLUMN public.properties.booking_about IS 'S602 public booking site — the landlord''s story / about-us section (who they are, family-owned, years running). Free text, rendered on the subdomain site.';
COMMENT ON COLUMN public.properties.booking_area IS 'S602 public booking site — local area & things-to-do section. Free text, rendered on the subdomain site.';
