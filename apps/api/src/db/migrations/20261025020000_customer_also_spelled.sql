-- 10/24 (Nic) — A MERGED DUPLICATE KEEPS EVERY SPELLING IT WAS EVER ENTERED UNDER.
--
--   "The two names of Worthman and Hammersmeyer that you are saying as different
--    people, those are each one person. It just wasn't spelled right. That's why
--    I want the auto-population of a customer name filled in from a phone
--    number... then you don't have to worry about people with weird last names
--    having different spelling."
--
-- Campground Master let the desk type a name fresh every visit, so a guest with
-- an awkward surname is in the file two or three times: Werthmann and Worthman
-- are one man, Hemmersmeier and Hemmersmeyer are one man.
--
-- Merging them is right, but merging by picking a winner DESTROYS the thing that
-- makes the merge findable. Somebody will type "Hemmersmeyer" at the counter —
-- it is on their paperwork from 2019 — and a search of first/last name alone
-- would then return nobody, which is worse than the duplicate was.
--
-- So every spelling a person has been entered under is kept here, on the one
-- surviving record, and the customer search reads it. Phone is still the
-- reliable key (Nic's point); this is what makes the NAME key survive a merge.
--
-- GAM never erases (standing rule): the losing row is archived, not deleted, and
-- its spelling moves here first. The landlord_elsewhere unique index is partial
-- on archived_at IS NULL, so archiving frees its Campground Master reference
-- without a constraint fight.
--
-- NO BACKFILL NEEDED. An empty array means "only ever spelled one way", which is
-- true of every record until a merge says otherwise.
ALTER TABLE pos_customers
  ADD COLUMN IF NOT EXISTS also_spelled TEXT[] NOT NULL DEFAULT '{}';

-- The search reads it with && / ANY, so a GIN index keeps a name lookup off a
-- full scan once a park has thousands of customers.
CREATE INDEX IF NOT EXISTS idx_pos_customers_also_spelled
  ON pos_customers USING GIN (also_spelled)
  WHERE archived_at IS NULL;

COMMENT ON COLUMN pos_customers.also_spelled IS
  'Other spellings this same person has been entered under, lowercased "first last", gathered when duplicates are merged. Read by the customer search so the old spelling still finds them.';
