-- S544: storefront guest inquiries (Nic).
--
-- The customer-facing per-property storefront (subdomain sites fronting
-- the S517/W-20 public booking API) needs an "ask about available
-- sites / amenities" contact path. Guests are anonymous — this stores
-- the inquiry durably and fans out a landlord notification (+email).
-- Public write surface: length-capped fields, no files, no auth.
--
-- handled_at is the landlord's "done" flag (surface lands with the
-- storefront's landlord-side inbox; the notification carries the full
-- message meanwhile).
--
-- No backfill needed.

CREATE TABLE property_inquiries (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  property_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  guest_name  text NOT NULL,
  guest_email text NOT NULL,
  guest_phone text,
  message     text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  handled_at  timestamptz
);

CREATE INDEX ix_property_inquiries_property
  ON property_inquiries(property_id) WHERE handled_at IS NULL;
