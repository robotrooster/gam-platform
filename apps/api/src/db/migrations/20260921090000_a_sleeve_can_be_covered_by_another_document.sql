-- S652 — A SLEEVE CAN BE COVERED BY A DOCUMENT IN ANOTHER SLEEVE.
--
-- Found building the sleeves for Blu: his Illinois lot lease already carries
-- the Park Owner Disclosure (Exhibit A) and the Park Rules (Exhibit B). Their
-- sleeves would have shown empty, which reads as "you're missing these" and
-- invites him to upload the same pages twice. A landlord can instead say that
-- sleeve is covered by a document he already has — the lease — and it counts as
-- filled, naming what covers it.
--
-- A covering is not a copy: nothing is duplicated, and a package that already
-- has the lease does not add it a second time.
--
-- No backfill needed.

CREATE TABLE sleeve_coverings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  landlord_id uuid NOT NULL REFERENCES landlords(id) ON DELETE CASCADE,
  sleeve_id   uuid NOT NULL REFERENCES document_sleeves(id),
  template_id uuid NOT NULL REFERENCES lease_templates(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (landlord_id, sleeve_id)
);
