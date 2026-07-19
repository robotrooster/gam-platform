-- S547: property-website photo gallery (Nic).
--
-- Each property's public subdomain site (S544 storefront) grows into a full
-- website: home/description, photo gallery, FAQ, booking. These are the
-- landlord-curated PUBLIC photos for that site — deliberately separate from
-- unit_photos (internal listing shots): what a landlord shows tenants in a
-- listing and what they market publicly are different sets, and the public
-- serving route must never be able to reach internal photos by design.
--
-- Files land on disk under uploads/property-site-photos (authed-route
-- pattern per S535); the PUBLIC read route only serves rows whose property
-- has public_booking_enabled=TRUE — publishing the site is the landlord's
-- explicit opt-in to public exposure.
--
-- No backfill needed.

CREATE TABLE property_site_photos (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  property_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  landlord_id uuid NOT NULL REFERENCES landlords(id) ON DELETE CASCADE,
  filename    text NOT NULL,
  caption     text,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ix_property_site_photos_property
  ON property_site_photos(property_id, sort_order);
