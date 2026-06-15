-- state_law_section_texts.law_category — broad real-estate-law area tag.
--
-- WHY: the full-text statute corpus began as landlord/tenant-only (that's the
-- live CS-agent surface), but the product needs ALL real-estate law over time
-- (fix-and-flip investors, commercial operators, agents). Rather than discard
-- the rest of each state's property statutes when we already fetch them, we
-- keep them in this same table tagged by area, and the landlord/tenant agent
-- retrieval (services/stateLaw.ts → searchStateLawText) filters to
-- law_category = 'landlord_tenant' so its answers stay clean. Future
-- investor/agent surfaces query the other categories.
--
-- Values are the single source of truth in packages/shared LAW_CATEGORY_VALUES;
-- this CHECK must list the same set. Add a value there AND in a fix-forward
-- migration — never edit this one once applied.
--
-- BACKFILL: every existing row is landlord/tenant, so the DEFAULT covers them;
-- no separate UPDATE needed. New broad-corpus rows set the appropriate area.

ALTER TABLE state_law_section_texts
  ADD COLUMN law_category text NOT NULL DEFAULT 'landlord_tenant';

ALTER TABLE state_law_section_texts
  ADD CONSTRAINT slst_law_category_check CHECK (law_category IN (
    'landlord_tenant',
    'conveyancing_title',
    'condo_coop',
    'broker_licensing',
    'mortgage_lien_foreclosure',
    'property_tax',
    'land_use_zoning',
    'environmental_disclosure',
    'general_real_property'
  ));

-- Retrieval and future category-scoped queries hit (state_code, law_category).
CREATE INDEX IF NOT EXISTS idx_slst_state_category
  ON state_law_section_texts (state_code, law_category);
