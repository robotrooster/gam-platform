-- 10/11 (Nic) — GAM BOOKS: ONE ACCOUNT PER CODE IN A COMPANY'S CHART
--
-- POST /books/accounts checked for the code and then inserted it — two
-- statements with nothing holding the code in between, so two saves at once
-- (a double-click, two tabs) could both pass the check and leave the chart
-- with two accounts numbered 4010. These indexes make the code unique within
-- one owner's chart (a landlord company's, or a business's — every Books table
-- carries exactly one of the two, books_accounts_one_owner). The route turns
-- the index's refusal into "Account code 4010 already exists".
--
-- Accounts with no owner (made by a GAM admin) are left out of both indexes,
-- as they were left out of the old check.
--
-- Existing rows: production had 0 accounts on 10/12 (read-only count). Should
-- any company already hold a duplicate code, every copy but the oldest is kept
-- and renumbered '<code>-2', '<code>-3', … so the index can be built without
-- removing anything (GAM keeps everything).
--
-- Backfill: only the renumbering above, and only if a duplicate exists.
-- Safe drop: both indexes.

WITH ranked AS (
  SELECT id,
         row_number() OVER (PARTITION BY landlord_id, business_id, code ORDER BY created_at, id) AS copy_no
    FROM books_accounts
   WHERE landlord_id IS NOT NULL OR business_id IS NOT NULL
)
UPDATE books_accounts a
   SET code = left(a.code, 16) || '-' || ranked.copy_no,
       updated_at = now()
  FROM ranked
 WHERE ranked.id = a.id
   AND ranked.copy_no > 1;

CREATE UNIQUE INDEX books_accounts_landlord_code_key
  ON books_accounts (landlord_id, code)
  WHERE landlord_id IS NOT NULL;

CREATE UNIQUE INDEX books_accounts_business_code_key
  ON books_accounts (business_id, code)
  WHERE business_id IS NOT NULL;
