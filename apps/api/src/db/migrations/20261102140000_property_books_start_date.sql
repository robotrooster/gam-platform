-- 11/2 (Nic) — A PROPERTY'S BOOKS START WHEN THAT PROPERTY STARTED.
--
--   "If I have one property now and I buy another property later, my books for
--    that property are going to start from when I bought that property.
--    Whether or not it's the same LLC is irrelevant. It's a completely separate
--    business revenue stream."
--
-- Until now the books start date lived only on the company (landlords
-- .books_start_date), so a second property bought later would have had its
-- whole pre-purchase history folded into the first property's opening balance —
-- money that was never this owner's, landing in this owner's books.
--
-- EXPAND ONLY. This file adds the column and copies each company's date onto
-- every property it holds. Nothing reads the new column yet and nothing
-- changes meaning: every live company with books holds exactly ONE property
-- (Mountain View RV Ranch, Oak Park Motel and RV, Country Acres - Mattoon), so
-- property date == company date for all three on the day this lands. The
-- company column stays and is NOT dropped — a bank connection, a bank
-- transaction, a reconciliation, a deposit slip and a month close are all
-- company-scoped with no property to ask, so the company keeps a date of its
-- own, which later becomes the earliest of its properties'.
--
-- NO BACKFILL NEEDED beyond the copy below: a property whose company never
-- picked a date gets NULL, which is exactly "these books have not started".
--
-- books_history_start is pure provenance — how the date was picked — and is
-- NULL on every live company, so its copy is a no-op today and exists so the
-- per-property setter has somewhere to record the same answer.

ALTER TABLE properties ADD COLUMN IF NOT EXISTS books_start_date date;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS books_history_start text;

-- ADD CONSTRAINT is not idempotent and this file is replayed by the migration
-- test, so drop first. Values mirror landlords_books_history_start_check and
-- packages/shared BOOKS_HISTORY_STARTS — one definition, three consumers.
ALTER TABLE properties DROP CONSTRAINT IF EXISTS properties_books_history_start_check;
ALTER TABLE properties ADD CONSTRAINT properties_books_history_start_check
  CHECK (books_history_start IS NULL
         OR books_history_start = ANY (ARRAY['since_joining'::text, 'start_date'::text]));

-- The copy. Only where the property has no date of its own, so a replay never
-- overwrites a date somebody has since set per property.
UPDATE properties p
   SET books_start_date = l.books_start_date,
       books_history_start = COALESCE(p.books_history_start, l.books_history_start)
  FROM landlords l
 WHERE l.id = p.landlord_id
   AND p.books_start_date IS NULL
   AND l.books_start_date IS NOT NULL;

-- Every company-scoped read of "when do this company's books start" becomes
-- MIN(books_start_date) over its properties; this is the index that serves it.
CREATE INDEX IF NOT EXISTS idx_properties_books_start
  ON properties (landlord_id, books_start_date);

COMMENT ON COLUMN properties.books_start_date IS
  'The first day this property''s money belongs in the books. Money dated before it folds into this property''s opening balance instead of posting. Per property because a property bought later is its own revenue stream (Nic, 11/2); the company''s own date (landlords.books_start_date) is the earliest of these and is what cuts the company-level bank feed.';
COMMENT ON COLUMN properties.books_history_start IS
  'How this property''s start date was chosen: since_joining (the month GAM began running it) or start_date (the owner named a day). Provenance only — nothing branches on it.';
