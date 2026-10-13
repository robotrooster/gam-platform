-- 10/12 (Nic) — GAM BOOKS, PHASE P6: TWO OWNER'S CHOICES FOR MONEY OUT AND IN
--
--   bookkeeper_scopes.money_in_filing   Nic L19: "bookkeepers filing money
--       coming in → LANDLORD'S CHOICE per bookkeeper (file anything / only
--       after 'Not rent' / never)". A deposit filed or ignored leaves the rent
--       queue, so a tenant's rent filed as other income stays open on the
--       tenant's account and late fees follow — which is why the default is
--       'after_not_rent' (design §11): the owner says a deposit is not rent
--       first (marking "Not rent" is the owner's). Money GOING out stays open
--       to a bookkeeper with the bank (the company-wide box). Values:
--       BOOKKEEPER_MONEY_IN_FILING (packages/shared/src/booksMoneyOut.ts).
--   landlords.books_repair_bills        Nic L6: "a repair closed with a cost →
--       LANDLORD'S CHOICE (auto unpaid bill vs a 'Record as bill' button)".
--       NULL = not chosen yet: nothing is made by itself and the button is
--       offered. Values: BOOKS_REPAIR_BILL_MODES.
--
-- Expand-only; safe before the code ships. No backfill needed: every existing
-- bookkeeper starts at the default (production on 10/12: 0 bookkeepers), and no
-- company has chosen a repair-bill mode yet.
-- Safe drop: the two columns.

SET LOCAL lock_timeout = '10s';

ALTER TABLE bookkeeper_scopes
  ADD COLUMN IF NOT EXISTS money_in_filing text NOT NULL DEFAULT 'after_not_rent';
ALTER TABLE bookkeeper_scopes DROP CONSTRAINT IF EXISTS bookkeeper_scopes_money_in_filing_check;
ALTER TABLE bookkeeper_scopes ADD CONSTRAINT bookkeeper_scopes_money_in_filing_check
  CHECK (money_in_filing IN ('any', 'after_not_rent', 'never'));

COMMENT ON COLUMN bookkeeper_scopes.money_in_filing IS
  '10/12 (Nic, L19): what this bookkeeper may file of the money coming in on the bank feed — any, only deposits marked "Not rent", or never. Money going out stays open to them (with the bank).';

ALTER TABLE landlords
  ADD COLUMN IF NOT EXISTS books_repair_bills text;
ALTER TABLE landlords DROP CONSTRAINT IF EXISTS landlords_books_repair_bills_check;
ALTER TABLE landlords ADD CONSTRAINT landlords_books_repair_bills_check
  CHECK (books_repair_bills IS NULL OR books_repair_bills IN ('automatic', 'button'));

COMMENT ON COLUMN landlords.books_repair_bills IS
  '10/12 (Nic, L6): what a repair closed with a cost does — ''automatic'' makes an unpaid bill by itself, ''button'' only on "Record as bill". NULL = not chosen yet (the button is offered).';
