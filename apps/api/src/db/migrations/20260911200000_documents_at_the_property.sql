-- S641 (Nic) — documents belong to a PROPERTY, and one document can serve
-- several of them.
--
--   "If you have a specific rule about trash or notices about stuff specific to
--    the property, you don't want that at the landlord level accidentally
--    getting sent to a property that doesn't pertain to them… maybe you have
--    assigned parking spots in one place and that gets sent to a property that
--    doesn't have that, and then it's just generating confusion."
--
--   "If I have parking rules at two of my properties and not at a third, I
--    don't wanna have to upload it two times. I wanna be able to pin it to
--    multiple properties and have it not go to the third."
--
-- A document could be tagged to a unit, a tenant or a lease — never to a
-- property. So park rules, trash notices and anything else you print and hand
-- over had nowhere to live, and the Documents tab was empty because there was
-- no shelf to put them on.

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS property_id uuid REFERENCES properties(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_documents_property
  ON documents (property_id) WHERE property_id IS NOT NULL;

-- ── Pinned to the properties it applies to ─────────────────────────────────
--
-- NO ROWS means available everywhere — a state disclosure, a lead-paint
-- pamphlet. Rows mean "only these". Absence is the permissive default so
-- nothing that exists today changes behaviour, and the same shape as
-- lease_template_properties so the two read alike.
CREATE TABLE IF NOT EXISTS document_properties (
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  property_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, property_id)
);

CREATE INDEX IF NOT EXISTS idx_document_properties_property
  ON document_properties (property_id);

-- ── What kind of thing it is ───────────────────────────────────────────────
--
-- The old list described things that come OUT of a signing flow — lease,
-- addendum, checklists, receipt. Nic's filing cabinet is the other kind: "our
-- park rules… most parks offer that as a separate bulletin board posted in the
-- office", things you print and physically hand somebody.
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_type_check;
ALTER TABLE documents ADD CONSTRAINT documents_type_check
  CHECK (type IN (
    'lease', 'addendum', 'move_in_checklist', 'move_out_checklist',
    'notice', 'receipt',
    'park_rules',   -- posted in the office, handed over at move-in
    'disclosure',   -- state-required paperwork you furnish
    'reference',    -- anything else kept to print and hand over
    'other'
  ));

-- Reference material is not about one resident. Marking it explicitly keeps a
-- park-rules sheet out of a tenant's own document list, where it would read as
-- something they signed.
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS is_reference boolean NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN documents.is_reference IS
  'S641: kept to print and hand over — not produced by a signing flow and never shown as something the tenant executed.';
