-- S652 — EVERY DOCUMENT HAS A SLEEVE.
--
-- Nic: "right now, all of my templates are just sitting there in a pool instead
-- of in a designated card slot. So for example, if I upload my Arizona property
-- and twelve documents are anticipated, that shows twelve blanks. The landlord
-- can just upload into spots they want to use. They're not required to use the
-- blank spots. But that hint of hey, there's more things to upload is there."
--
-- His words for it: the SLEEVE is the container, the CARD is the document that
-- fills it. A sleeve is one state, the kinds of space it is for, and what goes
-- in it — "Arizona: Mobile Home Lease", "Illinois: Park Rules". A landlord sees
-- the sleeves for the states they hold property in and the unit types they run;
-- the rest exist on the back end and appear the moment they add a property
-- there ("as soon as somebody uploads a property in Texas, boom, the Texas
-- documents show up").
--
-- WHAT A SLEEVE DOES NOT SAY. Nic: "we aren't enforcing the state laws. We also
-- don't want to say that it may be required. We just want to have it be a little
-- more subtle." A sleeve has a title and nothing else on screen. The statute that
-- put it there is kept (basis_*) so the catalog can be audited and refreshed
-- each year with the corpus, and is not shown.
--
-- Government-published forms are NOT sleeves here — they are the library, and
-- the page shows them as sleeves that come already filled. This table is the
-- documents a landlord has to write themselves.
--
-- A template fills a sleeve through lease_templates.sleeve_id. More than one
-- template may sit in the same sleeve (a park with two lot-lease versions); the
-- sleeve is "filled" if any active template is in it.
--
-- Packages gain a state, because a package is "my Arizona RV package": its
-- state and unit type are what let it pick its own documents from the filled
-- sleeves.
--
-- No backfill here — the catalog is generated from the statute corpus by
-- scripts/disclosures/buildSleeves.ts, and existing templates are placed into
-- sleeves by the same script.

CREATE TABLE document_sleeves (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sleeve_key        text NOT NULL UNIQUE,   -- lease:AZ:mobile_home, doc:IL:mobile_home:park_rules
  state_code        text NOT NULL CHECK (state_code = upper(state_code) AND length(state_code) = 2),
  kind              text NOT NULL CHECK (kind IN ('lease','sale_contract','disclosure')),
  purpose           text NOT NULL,          -- the lease_templates.purpose a template in it takes
  disclosure_type   text,
  unit_types        text[] NOT NULL,
  applies_to        text NOT NULL DEFAULT 'any' CHECK (applies_to IN ('any','rental','sale')),
  title             text NOT NULL,
  sort_order        integer NOT NULL,
  basis_citation    text,                   -- internal: the section(s) that put it here
  basis_section_ids uuid[],
  retired_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX document_sleeves_state ON document_sleeves (state_code) WHERE retired_at IS NULL;

ALTER TABLE lease_templates
  ADD COLUMN sleeve_id uuid REFERENCES document_sleeves(id);
CREATE INDEX lease_templates_sleeve ON lease_templates (sleeve_id) WHERE sleeve_id IS NOT NULL;

ALTER TABLE document_packages
  ADD COLUMN state_code text CHECK (state_code IS NULL OR (state_code = upper(state_code) AND length(state_code) = 2));
