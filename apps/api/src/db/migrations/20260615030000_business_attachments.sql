-- S509: polymorphic file attachments for business-portal entities.
--
-- One table — entity_type + entity_id pair points at the parent.
-- Lets us attach files to work orders, customers, quotes, invoices,
-- inventory items, and future surfaces (expenses, etc.) without
-- multiplying tables.
--
-- File contents live on disk under apps/api/uploads/
-- business-attachments/<businessId>/<storedFilename>. The DB tracks
-- the metadata + audit. mime_type is enforced at the route layer
-- (whitelist of images + PDFs in v1) — schema CHECK only enforces
-- non-empty + size bounds.
--
-- is_internal: when TRUE the file is hidden from any customer-facing
-- surface (the PDF service will skip these even if it later supports
-- embedding attachments). Useful for "internal photo of the
-- car's odometer" that the operator doesn't want on the customer's
-- printed receipt.
--
-- SAFE — additive only, no backfill.

CREATE TABLE public.business_attachments (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
    -- Polymorphic FK pair. The entity_id is intentionally NOT a
    -- foreign key — soft-link semantics let us attach to multiple
    -- entity types from one table. Cleanup on parent delete is
    -- handled at the route layer (or stranded rows are harmless).
    entity_type text NOT NULL,
    entity_id uuid NOT NULL,
    -- File details
    file_name text NOT NULL,
    file_size_bytes integer NOT NULL,
    mime_type text NOT NULL,
    stored_filename text NOT NULL,        -- our uuid-renamed name on disk
    description text,
    is_internal boolean DEFAULT FALSE NOT NULL,
    -- Audit
    uploaded_by_user_id uuid REFERENCES public.users(id),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT business_attachments_pkey PRIMARY KEY (id),
    CONSTRAINT business_attachments_entity_type_check CHECK (
      entity_type = ANY (ARRAY[
        'work_order'::text,
        'customer'::text,
        'quote'::text,
        'invoice'::text,
        'inventory_item'::text
      ])
    ),
    CONSTRAINT business_attachments_size_positive
      CHECK (file_size_bytes > 0 AND file_size_bytes <= 20971520),  -- 20MB
    CONSTRAINT business_attachments_filename_nonempty
      CHECK (length(file_name) > 0 AND length(stored_filename) > 0),
    CONSTRAINT business_attachments_mime_nonempty
      CHECK (length(mime_type) > 0)
);
CREATE INDEX idx_business_attachments_entity
  ON public.business_attachments (entity_type, entity_id, created_at DESC);
CREATE INDEX idx_business_attachments_business
  ON public.business_attachments (business_id, created_at DESC);

COMMENT ON TABLE public.business_attachments IS
  'S509 polymorphic file attachments. entity_type/entity_id soft-link to a parent row (work_order, customer, quote, invoice, inventory_item). Files on disk under uploads/business-attachments/<businessId>/<stored_filename>.';
