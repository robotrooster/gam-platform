-- S652: some documents belong to a SALE, some to a RENTAL, and the difference
-- is not something a name can carry.
--
-- Nic: "the goal was to have the package set up so you needed to detect who was
-- on rent to own or already tenant owned homes and apply that to the thing, and
-- have the leases that are just not on rent to own as the leased lead based
-- paint disclosure. The whole reason we built the packages process was for this
-- property."
--
-- Blu uploaded two lead-based-paint addenda — "Mattoon LBP - Lease" and
-- "Mattoon LBP - Sale" — because the federal disclosure genuinely differs
-- between selling a home and renting one. The system could not tell them apart:
-- every template he uploaded carries purpose 'lease', so the packet builder had
-- no way to put the right one in front of the right household, and a landlord
-- ticking by hand every time is how the wrong disclosure eventually gets signed.
--
-- WHY NOT A 'lead_paint' PURPOSE. Because lead paint is not the shape of the
-- problem — the transaction is. Any disclosure that differs between buying and
-- renting has this same split, and several do. So a template says which kind of
-- transaction it belongs to, and the packet asks the household which kind it is
-- having. Nothing here knows what lead is.
--
-- 'any' is the default and means what it always meant: include it regardless.

ALTER TABLE lease_templates
  ADD COLUMN IF NOT EXISTS applies_to TEXT NOT NULL DEFAULT 'any'
    CHECK (applies_to IN ('any', 'sale', 'rental'));

COMMENT ON COLUMN lease_templates.applies_to IS
  'S652: sale = the dwelling is being bought (rent-to-own); rental = the landlord is renting out a dwelling; any = both. Drives which disclosure the packet suggests.';
