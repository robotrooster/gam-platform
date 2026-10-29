-- 10/13 (Nic) — A RECORD THAT ARRIVES AFTER ITS ACCOUNT WAS DELETED POSTS TO THE REPLACEMENT
--
-- Nic, 10/13: a landlord deletes an account (say 'Repairs') and picks the one
-- that takes its place ('Maintenance'). Open months move to the replacement
-- and closed months keep the old account (10/12, services/booksLedgerChart
-- retireAccount). A record dated inside an already-CLOSED month that arrives
-- AFTER the deletion posts as a correction in the open month — to the
-- replacement (Nic chose "The replacement"). Until now it landed on the
-- deleted account: the engine resolved its lines on the record's own day,
-- and on a closed day the map still names the deleted account.
--
-- The engine (services/ledgerEngine, booksLedgerChart) now never puts a new
-- posting's line on a deleted account: a posting written today hands each
-- deleted account to the account that took its place (a reversal still
-- negates the posting it takes back line for line, on the accounts it was
-- posted to). A posting already in the books
-- stays as it is only while it sits on a day the deleted account kept — a
-- month that was closed when it was deleted. That day is this column: the
-- first day the replacement took over (the books' first open day at the
-- deletion; the whole history, the books' beginning, when nothing was
-- closed). It is fixed at the deletion, so a month reopened later never makes
-- what was posted to it before the deletion read as drift.
--
-- Expand-only: one nullable column and one check every existing row meets.
-- No backfill needed: production has no deleted account (no row has
-- replaced_by_account_id). NULL on a deleted account (turned off directly,
-- outside retireAccount) means nothing already posted moves by itself; new
-- postings still go to the replacement. Idempotent.

SET LOCAL lock_timeout = '10s';

ALTER TABLE books_accounts ADD COLUMN IF NOT EXISTS replaced_from date;

-- Only a deleted account that names its replacement has a day it took over.
ALTER TABLE books_accounts DROP CONSTRAINT IF EXISTS books_accounts_replaced_from_has_replacement;
ALTER TABLE books_accounts ADD CONSTRAINT books_accounts_replaced_from_has_replacement
  CHECK (replaced_from IS NULL OR replaced_by_account_id IS NOT NULL);

COMMENT ON COLUMN books_accounts.replaced_from IS
  '10/13 (Nic): the first day replaced_by_account_id took this deleted account''s postings — the books'' first open day when it was deleted (closed months keep this account). Postings already sitting before it stay here; anything posted on or after it, and every posting written after the deletion (a late record for a closed month included), goes to the replacement. NULL = not deleted through retireAccount.';
