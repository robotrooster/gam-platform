-- W-8 (S529): maintenance receipts ride the documents table — one storage
-- surface, auto-linked to the unit (documents.unit_id) so they also appear
-- on the Documents tab. This adds the 'receipt' category and the link back
-- to the maintenance request the receipt belongs to.
-- No backfill needed: no receipt rows exist yet.
ALTER TABLE documents DROP CONSTRAINT documents_type_check;
ALTER TABLE documents ADD CONSTRAINT documents_type_check
  CHECK (type = ANY (ARRAY['lease','addendum','move_in_checklist','move_out_checklist','notice','receipt','other']));
ALTER TABLE documents ADD COLUMN maintenance_request_id uuid REFERENCES maintenance_requests(id) ON DELETE SET NULL;
CREATE INDEX idx_documents_maintenance_request ON documents(maintenance_request_id) WHERE maintenance_request_id IS NOT NULL;
