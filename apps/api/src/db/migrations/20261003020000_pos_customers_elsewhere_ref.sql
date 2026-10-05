-- 10/2 (Nic, settled): the register finds people outside this company by part
-- of a name, or by an email or phone typed WHOLE (never a piece of one) — "If
-- there's five Bobs next door... I type Bob and then I remember the last
-- name... If they're a point of sale customer, it doesn't matter. It doesn't
-- link to the tenancy at all."
--
-- Picking one of them makes a register record in THIS company holding only
-- their name (and an email or phone the clerk typed in full). Nothing of the
-- other company's crosses over, so the new record has no contact detail to
-- recognize the person by the next time they are picked. This column is how
-- the register knows: the GAM account ('u:<users.id>') or other company's
-- register record ('c:<pos_customers.id>') the pick came from. It is never
-- shown and never sent to a screen; it is only compared.
--
--   * picking the same person again links to the same record (no duplicates);
--   * the search stops listing them as "from elsewhere" once they are this
--     company's own;
--   * a record that is itself a pick is never offered to a third company (the
--     person it copies is listed instead).
--
-- Expand-only: a nullable column and a partial unique index. Code that does
-- not know the column keeps working. No backfill — no record was made this way
-- before this column existed.
ALTER TABLE pos_customers ADD COLUMN IF NOT EXISTS elsewhere_ref text;

-- One live record per source per company. Archived (merged-away) records keep
-- theirs as history and do not count.
CREATE UNIQUE INDEX IF NOT EXISTS pos_customers_landlord_elsewhere_uniq
  ON pos_customers (landlord_id, elsewhere_ref)
  WHERE archived_at IS NULL AND elsewhere_ref IS NOT NULL;
