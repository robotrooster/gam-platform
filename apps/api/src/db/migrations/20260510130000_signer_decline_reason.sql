-- S234: lease_document_signers decline-with-reason columns.
--
-- The signer status enum already includes 'declined' (S233 schema:
-- pending|sent|viewed|signed|declined) but no audit columns existed
-- to capture WHEN the decline happened or WHY. Add them now ahead of
-- the decline endpoint + tenant-side decline button.
--
-- No backfill needed — existing rows (none currently 'declined' since
-- the path was never wired) get NULLs, which match the post-S234
-- semantics of "never declined".

ALTER TABLE lease_document_signers
  ADD COLUMN declined_at     timestamptz,
  ADD COLUMN decline_reason  text;
