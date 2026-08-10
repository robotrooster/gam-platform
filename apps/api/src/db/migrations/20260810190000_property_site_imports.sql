-- Booking-site importer (S601, Nic).
--
-- WHY: a landlord with an existing website can import it into the structured
-- booking-site model (import → editable template, NOT verbatim hosting) so they
-- don't rebuild from scratch, the site stays in GAM's bookable layout, and it can
-- join cross-property calendar features (road-trip planner). We ALSO keep the raw
-- HTML + extracted structure as a captured template on the backend — Nic wants to
-- data-collect everything people bring in.
--
-- One row per import attempt. raw_html = the fetched page (reference/template
-- snapshot); extracted = the parsed {intro, about, phone, email, imageUrls}. The
-- landlord reviews the preview and applies text (normal save) + selected photos
-- (server-side download); status tracks that lifecycle.
--
-- Safe drop: new table, no backfill.

CREATE TABLE property_site_imports (
  id           uuid DEFAULT uuid_generate_v4() NOT NULL PRIMARY KEY,
  property_id  uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  landlord_id  uuid NOT NULL REFERENCES landlords(id) ON DELETE CASCADE,
  source_url   text NOT NULL,
  final_url    text NOT NULL,
  raw_html     text NOT NULL,
  extracted    jsonb NOT NULL,
  status       text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'applied', 'discarded')),
  imported_by  uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  applied_at   timestamptz
);

CREATE INDEX property_site_imports_property_id_idx
  ON property_site_imports (property_id, created_at DESC);
