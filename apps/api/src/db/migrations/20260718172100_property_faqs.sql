-- S547: property-website FAQ page (Nic).
--
-- Landlord-authored question/answer pairs shown on the property's public
-- subdomain site (S544 storefront → full property website). Read publicly
-- only while the site is published (public_booking_enabled=TRUE), same
-- opt-in gate as the site itself.
--
-- No backfill needed.

CREATE TABLE property_faqs (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  property_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  landlord_id uuid NOT NULL REFERENCES landlords(id) ON DELETE CASCADE,
  question    text NOT NULL,
  answer      text NOT NULL,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ix_property_faqs_property
  ON property_faqs(property_id, sort_order);
