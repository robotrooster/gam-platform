-- S652 — THE LIBRARY IS GOVERNMENT-PUBLISHED DOCUMENTS, AND NOTHING ELSE.
--
-- Nic: "let's only the library should only be government published documents
-- that something we're not altering at all... Anything that the landlord has to
-- publish, they can do on their own. They can upload their own form the same way
-- they upload their own lease."
--
-- The case for this table is visible in the data today: Blu uploaded his own
-- copies of the FEDERAL lead-based paint disclosures, which are word-for-word
-- identical for every landlord in the country. Every landlord after him would
-- have uploaded the same two forms again.
--
-- WHAT GAM DOES NOT DO HERE. It does not author forms. It does not tell a
-- landlord what their state requires — Nic: "we don't want to show what the
-- statute asks for because a landlord may have properties in multiple states.
-- We don't want to clutter all that screen." A landlord with a statutory
-- obligation and no government form uploads their own, exactly as before.
-- Attorney-verified state forms come later, when there are attorneys on
-- retainer; the source columns below are shaped so that day is an INSERT.
--
-- THE DOCUMENT IS FIXED. THE SIGNING LAYER IS OURS. Nic: "they can't alter the
-- document, but when they send it out for signature, it needs to have
-- e-signature flow on it where the page can at least have the tenant's initials
-- that they received it as part of the lease signing flow." So the library owns
-- BOTH the PDF and the field map; a landlord adopting a form gets both and can
-- edit neither. The government's page is untouched and the acknowledgement on
-- top of it is GAM's.
--
-- HOW A LANDLORD HOLDS ONE. Not a parallel universe: adoption creates an
-- ordinary lease_templates row pointing back here. Packets, sending, signing and
-- stamping all keep working because it IS a template — only locked. That also
-- makes the annual refresh reach people, which was the whole point of a linked
-- copy over a download: bump the version here, re-sync every adopted template.
-- Documents already sent are untouched, because lease_documents snapshots its
-- own base_pdf_url and its own fields at creation.
--
-- No backfill needed — the library starts empty and is seeded separately, once
-- the source PDFs are pulled from the publishing agency.

CREATE TABLE disclosure_library_documents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  disclosure_type  text NOT NULL,
  -- 'US' for a federal form, else the two-letter state code it was published for.
  jurisdiction     text NOT NULL,
  applies_to       text NOT NULL DEFAULT 'any'
                     CHECK (applies_to IN ('any','rental','sale')),
  -- NULL = every kind of space. A form written for mobile home parks says so.
  unit_types       text[],
  name             text NOT NULL,
  description      text,
  -- Provenance is not decoration: it is the whole claim this table makes. A row
  -- with no publisher is not a government document and does not belong here.
  source_name      text NOT NULL,
  source_url       text NOT NULL,
  publication_ref  text,
  base_pdf_url     text NOT NULL,
  page_count       integer NOT NULL DEFAULT 1,
  -- Bumped by the annual refresh. Old rows are never edited: a new version is a
  -- new row, and the old one points forward, so "which version did this tenant
  -- get?" stays answerable years later.
  version          integer NOT NULL DEFAULT 1,
  effective_from   date NOT NULL DEFAULT CURRENT_DATE,
  superseded_by_id uuid REFERENCES disclosure_library_documents(id),
  retired_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX disclosure_library_lookup
  ON disclosure_library_documents (jurisdiction, disclosure_type)
  WHERE retired_at IS NULL AND superseded_by_id IS NULL;

-- The field map GAM ships with the form. Same shape as lease_template_fields so
-- adoption is a copy, not a translation.
CREATE TABLE disclosure_library_fields (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id  uuid NOT NULL REFERENCES disclosure_library_documents(id) ON DELETE CASCADE,
  field_type   text NOT NULL,
  signer_role  text,
  label        text,
  lease_column text,
  page         integer NOT NULL DEFAULT 1,
  x            double precision,
  y            double precision,
  width        double precision NOT NULL DEFAULT 200,
  height       double precision NOT NULL DEFAULT 50,
  required     boolean NOT NULL DEFAULT true,
  sort_order   integer NOT NULL DEFAULT 0,
  options      text,
  default_value text,
  checkbox_mark text NOT NULL DEFAULT 'x' CHECK (checkbox_mark IN ('x','check')),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX disclosure_library_fields_doc ON disclosure_library_fields (document_id);

-- The landlord's linked copy. Set = this template's content is GAM's, not the
-- landlord's, and the edit routes refuse it.
ALTER TABLE lease_templates
  ADD COLUMN library_document_id uuid REFERENCES disclosure_library_documents(id);

CREATE INDEX lease_templates_library_doc
  ON lease_templates (library_document_id)
  WHERE library_document_id IS NOT NULL;

-- One landlord adopts a given form once.
CREATE UNIQUE INDEX lease_templates_one_adoption_per_landlord
  ON lease_templates (landlord_id, library_document_id)
  WHERE library_document_id IS NOT NULL;
