-- S655 (Nic, Oak Park PNC relink): say WHY a bank row is ignored, tie a copy to
-- the row it copies, and follow the bank's own pending/posted/void state.
--
-- Relinking PNC on 9/26 imported Oak Park's history a second time: 104 rows on
-- the new link are copies of rows on the retired one, and 69 of them predate the
-- books start date. Three gaps made that impossible to tidy safely:
--   * `ignored` could not tell "the landlord dismissed it" from "before the
--     books start" from "a copy", so saving the books start date brought every
--     ignored row on/after it back into review — copies included.
--   * nothing pointed a copy at the row that was kept, so hiding one was
--     indistinguishable from losing one.
--   * the feed stored pending transactions and never updated them, so the old
--     link kept the bank's short pending wording and dates forever, and a
--     pending charge the bank later voided stayed as a real row.
--
-- Additive (expand). Safe before the code ships: the running build never reads
-- or writes these columns. No CHECK ties ignored_reason to status, on purpose —
-- the running build moves rows out of `ignored` without knowing the column, and
-- such a CHECK would make its books-start save fail.
ALTER TABLE bank_transactions
  ADD COLUMN IF NOT EXISTS ignored_reason text,
  ADD COLUMN IF NOT EXISTS duplicate_of_id uuid REFERENCES bank_transactions(id),
  ADD COLUMN IF NOT EXISTS bank_status text;

ALTER TABLE bank_transactions
  ADD CONSTRAINT bank_transactions_ignored_reason_check
    CHECK (ignored_reason IS NULL OR ignored_reason IN ('landlord', 'before_books', 'duplicate', 'bank_void')),
  ADD CONSTRAINT bank_transactions_bank_status_check
    CHECK (bank_status IS NULL OR bank_status IN ('pending', 'posted', 'void')),
  -- A copy always says what it copies; nothing is hidden without a pointer back.
  ADD CONSTRAINT bank_transactions_duplicate_points_at_original
    CHECK (ignored_reason IS DISTINCT FROM 'duplicate' OR duplicate_of_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_bank_transactions_duplicate_of
  ON bank_transactions (duplicate_of_id) WHERE duplicate_of_id IS NOT NULL;

COMMENT ON COLUMN bank_transactions.ignored_reason IS 'S655: why an ignored row is ignored — landlord (pressed Ignore), before_books (before landlords.books_start_date; moves with it), duplicate (a copy of duplicate_of_id), bank_void (the bank voided it). NULL when not ignored.';
COMMENT ON COLUMN bank_transactions.duplicate_of_id IS 'S655: for ignored_reason = duplicate, the row that was kept (on the same physical account, usually another link).';
COMMENT ON COLUMN bank_transactions.bank_status IS 'S655: the bank''s own state (Stripe FC): pending / posted / void. NULL on rows imported before S655.';

-- Backfill: every ignored row today was either before its company's books start
-- (auto-ignored on import or by the books-start save) or dismissed by the
-- landlord. Production: all 98 are before_books.
UPDATE bank_transactions t
   SET ignored_reason = CASE
         WHEN l.books_start_date IS NOT NULL AND t.posted_date < l.books_start_date THEN 'before_books'
         ELSE 'landlord'
       END
  FROM landlords l
 WHERE l.id = t.landlord_id
   AND t.status = 'ignored'
   AND t.ignored_reason IS NULL;
