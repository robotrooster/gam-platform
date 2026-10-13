-- 10/12 (Nic) — A BOOKKEEPER'S COMPANY-WIDE BOX, AND THE LEASE-DATES BOX
--
-- Nic's 10/12 answers on the bookkeeper boxes built 10/11:
--
--   1. "Company-wide: bank account, payouts and payroll" is its own box, the
--      owner's choice, separate from the property boxes. Until today a
--      bookkeeper got the bank account, payouts and the company-level Books
--      reports by INFERENCE: when every property the company owns was ticked
--      (lib/bookkeeperScope covers_all). That inference goes. The company-wide
--      box now decides the bank account, payouts, payroll and the company's
--      Books ledger and reports (P&L, cash flow, owner statements); the
--      property boxes keep deciding property money.
--   2. A bookkeeper may keep a company with NO property ticked, as long as the
--      company-wide box is ticked (a company with no property yet included).
--      Only "nothing ticked at all" is refused.
--   4. Lease start and end dates on a bookkeeper's rent roll are the owner's
--      choice per bookkeeper ("Show lease start and end dates", off unless
--      ticked). Never the lease text or its documents.
--
--   company_wide      the company-wide box (default off)
--   show_lease_dates  the lease-dates box (default off)
--
-- BACKFILL — nobody loses access. A row that today covers every property the
-- company owns (the old inference, the same test as lib/bookkeeperScope
-- coversAllSql: at least one ticked, none unticked), and an old NULL row
-- ("every property", still read that way in the expand window), gets
-- company_wide = TRUE: that bookkeeper sees the bank account, payouts and the
-- company reports today, and still does tomorrow. Everyone else starts with
-- the box off, which is what they have today. Pending bookkeeper invitations
-- get the same reading of their scope_payload (companyWide), so accepting one
-- grants what it grants today. show_lease_dates starts off for everyone: the
-- Books rent roll carried no lease dates before today, for anyone.
--
-- The property list may now be EMPTY (a company-wide-only bookkeeper, or one
-- whose only ticked property was sold — see 20261012170100, which keeps it as
-- a former property). bookkeeper_scopes_property_ids_not_empty (20261011120000)
-- is dropped: "nothing ticked at all" is refused by the writers
-- (routes/scopes), which can see the company-wide box and the former
-- properties a CHECK cannot. NULL still means "every property" until the NOT
-- NULL contract step; [] means none, and every reader takes it that way
-- (lib/bookkeeperScope keptIdsSql filters the list against the company).
--
-- Safe drop: the two columns, and re-add the not-empty CHECK once no row holds
-- an empty list. Re-running is a no-op (IF NOT EXISTS; the backfill only turns
-- the box on where the old inference already gave the access).

ALTER TABLE bookkeeper_scopes
  ADD COLUMN IF NOT EXISTS company_wide boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS show_lease_dates boolean NOT NULL DEFAULT false;

ALTER TABLE bookkeeper_scopes DROP CONSTRAINT IF EXISTS bookkeeper_scopes_property_ids_not_empty;

UPDATE bookkeeper_scopes bs
   SET company_wide = TRUE, updated_at = NOW()
 WHERE NOT bs.company_wide
   AND (bs.property_ids IS NULL
        OR (EXISTS (SELECT 1 FROM properties p
                     WHERE p.landlord_id = bs.landlord_id AND p.id = ANY(bs.property_ids))
            AND NOT EXISTS (SELECT 1 FROM properties p
                             WHERE p.landlord_id = bs.landlord_id AND NOT (p.id = ANY(bs.property_ids)))));

-- Pending invitations: companyWide = true where the payload names every
-- property the company owns today (or none at all — the pre-10/11 "every
-- property" shape that 20261012160000 writes out). Every other pending
-- bookkeeper invitation says companyWide = false out loud, so the accept step
-- never has to guess.
UPDATE invitations i
   SET scope_payload = jsonb_set(COALESCE(i.scope_payload, '{}'::jsonb), '{companyWide}',
         to_jsonb(
           -- CASE, not OR: jsonb_array_length on a non-array would throw.
           CASE WHEN jsonb_typeof(i.scope_payload->'propertyIds') IS DISTINCT FROM 'array' THEN TRUE
                WHEN jsonb_array_length(i.scope_payload->'propertyIds') = 0 THEN TRUE
                ELSE EXISTS (SELECT 1 FROM properties p
                              WHERE p.landlord_id = i.landlord_id
                                AND i.scope_payload->'propertyIds' ? p.id::text)
                 AND NOT EXISTS (SELECT 1 FROM properties p
                                  WHERE p.landlord_id = i.landlord_id
                                    AND NOT (i.scope_payload->'propertyIds' ? p.id::text))
           END))
 WHERE i.role = 'bookkeeper'
   AND i.status = 'pending'
   AND NOT (COALESCE(i.scope_payload, '{}'::jsonb) ? 'companyWide');

COMMENT ON COLUMN bookkeeper_scopes.company_wide IS
  '10/12 (Nic): the Company-wide box — the bank account, payouts, payroll and the company''s Books ledger and reports (P&L, cash flow, owner statements). The property boxes (property_ids) decide property money.';
COMMENT ON COLUMN bookkeeper_scopes.show_lease_dates IS
  '10/12 (Nic): the owner''s choice to show this bookkeeper each unit''s lease start and end dates on the Books rent roll. Never the lease text or documents.';
