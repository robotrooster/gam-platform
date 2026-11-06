-- 10/24–27 (Nic) — A FILING CABINET, NOT A SIGNING FLOW.
--
--   "do I want to upload my specific property notices to the templates page?
--    It's not something people are gonna be signing, but if we have to print
--    and give notice at a property, I'd like to have all my other documents
--    that have to physically be handed out kind of in a folder uploaded to this
--    platform. I'd like them to show up in the documents tab but there's no
--    upload a document button. It just says send a document. So that workflow
--    is kinda broken."
--
-- Every document path on the platform assumes a SIGNING flow: a template is a
-- thing that gets filled and signed, and a lease_document is an instrument with
-- signers and a status. There has been no notion of a reference document a
-- landlord keeps to print and hand over — park rules, notices, utility
-- instructions, anything physically delivered.
--
-- WHERE IT LIVES, 10/27, when asked whether this is per property or per
-- landlord:
--
--   "I would say documents live, make it a subfolder. Make documents show per
--    property and then per landlord as well. Like, if it's a document that's
--    used at multiple properties, have it show up in both spots... That way
--    it's quick access no matter where you're looking for it."
--
-- So a document is the LANDLORD's, and it is shown at the properties it was
-- marked for. No rows in reference_document_properties means it belongs to the
-- whole company and shows everywhere — which is the right default for a form
-- that is not park-specific, and saves ticking every box.
--
-- This mirrors lease_template_properties, which is the same idea for the
-- signing side; Nic remembered that flow and asked for this to work the way it
-- does.
--
-- NOTHING IS SERVED STATICALLY. The file is read back through an authenticated
-- route that checks the row against the caller's own companies and properties
-- (GAM serves no public /uploads path), so a stored path is not a link anybody
-- can follow.

CREATE TABLE IF NOT EXISTS public.reference_documents (
  id             uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
  landlord_id    uuid NOT NULL REFERENCES public.landlords(id),

  title          text NOT NULL,
  -- What the landlord's own file was called, kept so a download gives them
  -- back the name they know rather than a uuid.
  original_name  text NOT NULL,
  -- Relative to the uploads root; never a URL and never served directly.
  file_path      text NOT NULL,
  mime_type      text,
  size_bytes     bigint,
  notes          text,

  uploaded_by    uuid REFERENCES public.users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  -- GAM keeps what was ever real: removing a document hides it, and the file
  -- and the record stay.
  removed_at     timestamptz,
  removed_by     uuid REFERENCES public.users(id),

  CONSTRAINT reference_documents_title_not_blank CHECK (btrim(title) <> ''),
  CONSTRAINT reference_documents_removed_is_stamped
    CHECK ((removed_by IS NULL) OR (removed_at IS NOT NULL))
);

-- Which properties it is shown at. NO ROWS = the whole company.
CREATE TABLE IF NOT EXISTS public.reference_document_properties (
  document_id  uuid NOT NULL REFERENCES public.reference_documents(id) ON DELETE CASCADE,
  property_id  uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  PRIMARY KEY (document_id, property_id)
);

CREATE INDEX IF NOT EXISTS idx_reference_documents_landlord
  ON public.reference_documents (landlord_id) WHERE removed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_reference_document_properties_property
  ON public.reference_document_properties (property_id);

COMMENT ON TABLE public.reference_documents IS
  '10/24-27 (Nic): a document a landlord keeps to PRINT AND HAND OVER — park '
  'rules, notices, utility instructions. Not a template and not an instrument: '
  'nobody signs it. Shown on the Documents tab per property and per landlord, '
  'marked reference-only so nobody sends it for signature.';

COMMENT ON TABLE public.reference_document_properties IS
  'Which properties a reference document is shown at. NO ROWS means the whole '
  'company, which is the right default for a form that is not park-specific '
  '(Nic: "if it''s a document that''s used at multiple properties, have it show '
  'up in both spots").';
