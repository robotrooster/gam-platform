-- S622: per-page progress on auto-field placement jobs.
--
-- WHY: the placement runs the model ONE PAGE AT A TIME, sequentially
-- (modelClassify), so the work is already countable — we just never reported it.
-- An eight-page lease takes ~100s and the editor showed an unlabelled spinner
-- for all of it, which is indistinguishable from a hang. Nic sat through one
-- and asked whether it had died. It hadn't.
--
-- pages_total is NULL until the PDF is parsed and the page count is known
-- (a second or two in); the UI says "Reading the document…" until then and
-- "Analyzing page 3 of 8…" after. Transient work-tracking, same as the rest of
-- this table. No backfill: in-flight jobs simply report no progress and fall
-- back to the elapsed-time estimate.

ALTER TABLE auto_field_jobs
  ADD COLUMN IF NOT EXISTS pages_total int,
  ADD COLUMN IF NOT EXISTS pages_done  int NOT NULL DEFAULT 0;
