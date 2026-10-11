-- S652 — LIBRARY COVERAGE: WHAT WE LOOK FOR IN EVERY STATE, AND WHAT BECAME OF IT.
--
-- Nic: "I want to have a fully documented what you're looking for per state. If
-- anything was unable to be found, why it was unable to be found, and then we'll
-- chase it down later on. But I don't want to accidentally neglect something. I
-- want full coverage of anything left behind."
--
-- One row per (state, item). An item is either a SLEEVE the statute corpus says
-- a landlord hands over (source='statute'), a STANDARD thing governments commonly
-- publish that we check in every state whatever the corpus says (source=
-- 'standard'), or a known hole in the corpus itself (source='corpus_gap') — the
-- corpus holds landlord-tenant acts, not health codes, so a sleeve list alone
-- would silently miss lead/radon/mold rules.
--
-- status:
--   to_search       — nobody has looked yet
--   found           — shelved; library_document_id points at it
--   none_published  — looked; the government publishes no document for this
--   blocked         — exists but could not be fetched (reason says why)
--   not_applicable  — the state has no such law or space (reason says why)
--
-- reason / where_searched are required for every status but to_search and
-- found, so "nothing found" can never be recorded without saying why.
-- No backfill: scripts/disclosures/seedCoverage.ts fills and re-fills it.
CREATE TABLE IF NOT EXISTS library_coverage_items (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state_code          text NOT NULL,
  item_key            text NOT NULL,
  source              text NOT NULL CHECK (source IN ('statute','standard','corpus_gap')),
  what                text NOT NULL,
  unit_types          text[],
  basis               text,
  sleeve_id           uuid REFERENCES document_sleeves(id),
  status              text NOT NULL DEFAULT 'to_search'
                        CHECK (status IN ('to_search','found','none_published','blocked','not_applicable')),
  library_document_id uuid REFERENCES disclosure_library_documents(id),
  reason              text,
  where_searched      text,
  searched_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (state_code, item_key),
  CHECK (status NOT IN ('none_published','blocked','not_applicable') OR (reason IS NOT NULL AND length(trim(reason)) > 0)),
  CHECK (status <> 'found' OR library_document_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS library_coverage_items_status_idx ON library_coverage_items (status, state_code);
