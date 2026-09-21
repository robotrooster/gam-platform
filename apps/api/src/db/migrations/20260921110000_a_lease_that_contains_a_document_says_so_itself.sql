-- S652 — A LEASE THAT CONTAINS A DOCUMENT SAYS SO ITSELF.
--
-- Nic: "Yes, I want it to auto-confirm based on uploaded leases. And that way
-- it's not sending people duplicate stuff accidentally... If somebody uploads a
-- new lease, have it reread on the upload... if I change my draft next year, and
-- I leave out some of the stuff that was auto selected on the first lease, it
-- needs to reread that and deselect the options that are no longer applicable,
-- that way I can upload my own separate form for that category."
--
-- So a covering now records WHO made it:
--   'auto'   — found in the document's own text; re-read and replaced every time
--              that document's PDF changes, so a section taken out of next
--              year's lease un-ticks itself.
--   'manual' — the landlord ticked it; a re-read never touches it.
-- `evidence` is the passage the reading found, so the page can show why.
--
-- Existing rows are manual (the landlord ticked them). No backfill needed for
-- the columns; the detection runs over existing templates separately.

ALTER TABLE sleeve_coverings
  ADD COLUMN source text NOT NULL DEFAULT 'manual' CHECK (source IN ('auto','manual')),
  ADD COLUMN evidence text;
