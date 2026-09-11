-- S641 (Nic): a template field can come pre-answered.
--
--   "one page had a bunch of check boxes on there that are optional. But for
--    that particular property, they're all gonna be checked always for every
--    tenant… it's not a this-or-that thing. It's a tenant is responsible for
--    box one electricity, box two water, box three sewer, box four trash."
--
-- Prefill until now meant "copy a value we already know about this lease" —
-- tenant name, rent, dates. There was no way to say "this box starts ticked",
-- so a landlord re-ticked the same four boxes on every lease they ever sent.
--
-- default_value is the field's starting answer when nothing else fills it. A
-- lease_column prefill still wins: a known fact beats a template's assumption.
ALTER TABLE lease_template_fields
  ADD COLUMN IF NOT EXISTS default_value text;

-- How a ticked box is drawn. Nic: "it needs to be a check or an x, not just a
-- solid square, because that could be ambiguous" — a filled square reads as
-- redaction or as "not applicable" depending on who is looking at it.
ALTER TABLE lease_template_fields
  ADD COLUMN IF NOT EXISTS checkbox_mark text NOT NULL DEFAULT 'x';

ALTER TABLE lease_template_fields
  DROP CONSTRAINT IF EXISTS lease_template_fields_checkbox_mark_check;
ALTER TABLE lease_template_fields
  ADD CONSTRAINT lease_template_fields_checkbox_mark_check
  CHECK (checkbox_mark IN ('x', 'check'));

-- The document's own copy, so changing a template never rewrites a lease
-- somebody already signed.
ALTER TABLE lease_document_fields
  ADD COLUMN IF NOT EXISTS checkbox_mark text NOT NULL DEFAULT 'x';

ALTER TABLE lease_document_fields
  DROP CONSTRAINT IF EXISTS lease_document_fields_checkbox_mark_check;
ALTER TABLE lease_document_fields
  ADD CONSTRAINT lease_document_fields_checkbox_mark_check
  CHECK (checkbox_mark IN ('x', 'check'));
