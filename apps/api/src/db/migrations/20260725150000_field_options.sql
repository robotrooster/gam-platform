-- S556 (Nic): persist radio_group / multiple-choice OPTIONS on e-sign fields.
--
-- WHY: the template editor already lets a landlord configure a radio_group's
-- choices (e.g. "Fixed term, Month-to-month") and the sign flow renders them,
-- but the options string was never saved — the PUT /templates/:id/fields
-- payload dropped it and there was no column — so every radio group fell back
-- to a hardcoded "Yes,No". This adds the missing column on both the template
-- fields and the per-document field copies so a configured choice survives
-- save → send → sign.
--
-- Format: comma-separated option labels (matches the editor input + the sign
-- renderer split(',')). NULL for non-radio fields. No backfill needed.

ALTER TABLE public.lease_template_fields ADD COLUMN IF NOT EXISTS options text;
ALTER TABLE public.lease_document_fields ADD COLUMN IF NOT EXISTS options text;
