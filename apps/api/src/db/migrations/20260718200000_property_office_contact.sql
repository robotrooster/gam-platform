-- S547: property-website contact page (Nic).
--
-- Office phone + hours + email for the property's public subdomain site.
-- "People don't read until they're way too far into their situation, and
-- that's when they need a phone number" — a dedicated Contact page carries
-- what Google carries, on the property's own site. Free-form hours text
-- (multiline) — office schedules are too irregular for structured fields.
--
-- No backfill needed (NULL = field simply not shown on the site).

ALTER TABLE properties
  ADD COLUMN office_phone text,
  ADD COLUMN office_email text,
  ADD COLUMN office_hours text;
