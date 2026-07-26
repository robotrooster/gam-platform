-- S556 (Nic): conditional (nested) radio fields. A field can depend on another
-- field's selected option — e.g. the "at end of term" sub-choice (auto_renew_mode)
-- is shown AND required only when the "lease type" radio (lease_type) = "Fixed
-- term". Each level stays its own field bound to its own lease_column, so the
-- lease engine keeps reading lease_type / auto_renew_mode as separate columns;
-- the parent link only governs when the child is visible/required at signing.
--
-- parent_field_id references the PARENT lease_template_field. On the per-document
-- copy we carry the same parent_field_id (still pointing at the TEMPLATE field id)
-- plus each field's template_field_id, so the sign UI matches a child to its
-- parent doc field by (child.parent_field_id == parent.template_field_id).
--
-- parent_option = the parent's selected value that reveals/requires this child.
-- NULL parent_field_id = top-level field (current behavior). No backfill needed.

ALTER TABLE public.lease_template_fields
  ADD COLUMN IF NOT EXISTS parent_field_id uuid,
  ADD COLUMN IF NOT EXISTS parent_option text;

ALTER TABLE public.lease_document_fields
  ADD COLUMN IF NOT EXISTS parent_field_id uuid,
  ADD COLUMN IF NOT EXISTS parent_option text;

-- Self-referential FK on template fields: deleting a parent nulls the child's
-- link (the child degrades to an always-shown field rather than dangling).
ALTER TABLE public.lease_template_fields
  ADD CONSTRAINT lease_template_fields_parent_fk
  FOREIGN KEY (parent_field_id) REFERENCES public.lease_template_fields(id) ON DELETE SET NULL;
