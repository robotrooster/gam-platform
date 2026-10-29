-- 10/12 (Nic) — GAM BOOKS: WHAT THE OPENING BALANCES STEP NEEDS TO RECORD
--
-- The Opening balances step (routes/booksSettings.ts, the Books "Opening
-- Balances" page) is where an owner enters, once, what GAM has no record of on
-- the books start date (gam-ledger-design-2026-10-12 §4, §15 step 5; Nic 10/12:
-- "history start = landlord's choice (since joining GAM, or a start date +
-- opening balances)", L14 "pre-GAM deposits: landlord's choice"). The table
-- (books_opening_items, 20261013200500) already holds a bank balance (its
-- bank connection) and a deposit the landlord holds (its lease). Two facts
-- were missing:
--
--   account_id  an "other" opening balance — cash on hand, an account GAM
--               does not see, a loan, equipment — names the account it opens
--               on. Without it the item says how much but not where. Its
--               amount reads in the account's normal sense (an asset the
--               company has, a liability it owes, equity), the same as the
--               chart shows balances. The route only offers balance-sheet
--               accounts no automatic posting role proves against GAM's money
--               records (never receivables, money GAM holds, deposits owed,
--               opening balance equity itself). Captured for posting: the
--               opening projector reads it.
--   paid_on     the day a tenant paid a deposit the landlord still holds
--               ("tenant, amount, date"). Kept for the deposit's history (how
--               long it has been held); the opening posting is dated the books
--               start date either way, so it is not a posting column.
--
-- And three rules the step relies on, held by the database too:
--   - an "other" item names its account;
--   - a deposit held is a positive amount with the day it was paid;
--   - a void says why (keep everything: an item entered by mistake is voided
--     with a reason, never removed — the change journal records the rest).
--
-- The opening posting itself is the engine's 'opening' source (one per
-- company, re-projected whenever an item changes — the capture trigger below).
--
-- The ledger is DARK: nothing posts from these yet. Expand-only: two nullable
-- columns; the CHECKs are added NOT VALID then validated (the table is new and
-- empty in production). Re-installing the capture replaces its three trigger
-- bodies only (ledger_install_capture, 20261013200600), which takes no table
-- lock beyond a write's. Safe to apply before the code ships.
-- No backfill needed (no rows).
-- Safe drop: the two columns and three CHECKs, then re-install the capture with
-- the 20261013200600 column list.

SET LOCAL lock_timeout = '10s';

ALTER TABLE books_opening_items
  ADD COLUMN IF NOT EXISTS account_id uuid REFERENCES books_accounts(id),
  ADD COLUMN IF NOT EXISTS paid_on    date;

ALTER TABLE books_opening_items DROP CONSTRAINT IF EXISTS books_opening_items_other_names_account;
ALTER TABLE books_opening_items DROP CONSTRAINT IF EXISTS books_opening_items_deposit_paid;
ALTER TABLE books_opening_items DROP CONSTRAINT IF EXISTS books_opening_items_void_says_why;

ALTER TABLE books_opening_items
  ADD CONSTRAINT books_opening_items_other_names_account
    CHECK (kind <> 'other' OR account_id IS NOT NULL) NOT VALID,
  ADD CONSTRAINT books_opening_items_deposit_paid
    CHECK (kind <> 'deposit_held' OR (amount > 0 AND paid_on IS NOT NULL)) NOT VALID,
  ADD CONSTRAINT books_opening_items_void_says_why
    CHECK (voided_at IS NULL OR length(btrim(COALESCE(void_reason, ''))) > 0) NOT VALID;

ALTER TABLE books_opening_items VALIDATE CONSTRAINT books_opening_items_other_names_account;
ALTER TABLE books_opening_items VALIDATE CONSTRAINT books_opening_items_deposit_paid;
ALTER TABLE books_opening_items VALIDATE CONSTRAINT books_opening_items_void_says_why;

CREATE INDEX IF NOT EXISTS books_opening_items_account ON books_opening_items (account_id) WHERE account_id IS NOT NULL;

COMMENT ON COLUMN books_opening_items.account_id IS
  '10/12 (Nic): the account an "other" opening balance opens on; its amount reads in that account''s normal sense (asset held, liability owed, equity).';
COMMENT ON COLUMN books_opening_items.paid_on IS
  '10/12 (Nic, L14): the day the tenant paid a deposit the landlord still holds from before GAM.';

-- The opening posting re-projects when an item's account changes too
-- (LEDGER_CAPTURE_COLUMNS.books_opening_items, packages/shared).
SELECT ledger_install_capture('books_opening_items',
  ARRAY['landlord_id', 'business_id', 'kind', 'lease_id', 'tenant_id', 'property_id', 'bank_connection_id', 'amount', 'as_of', 'voided_at', 'account_id'],
  $k$SELECT 'opening'::text, COALESCE(r.landlord_id, r.business_id)::text, COALESCE(r.landlord_id, r.business_id)$k$);
