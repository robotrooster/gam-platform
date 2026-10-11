-- S652 — TWO THINGS NIC SETTLED IN ONE BREATH.
--
-- 1. BILL REVIEW IS PLATFORM-WIDE. Nic: "all these features need to be platform
--    wide. I don't want every single different landlord having a different user
--    experience... I'm not going to remember what I built for who." So the
--    per-property switch added the same day goes: every property's utility bills
--    wait for the landlord's approval. No code in production ever read the
--    column (that deploy never shipped), so dropping it is safe.
--
-- 2. FIELD PERMISSIONS ON A WORK-TRADE AGREEMENT. Nic: "Curtis needs to be able
--    to do and initiate the meter reading... stuff that's in the field —
--    maintenance and meter reads and repairs — need to be permissible when
--    toggled by the landlord for tenants on work trade." Office work (point of
--    sale, money) stays with team accounts. 'read_meters' is the first; the
--    CHECK is widened as more field work is named.
ALTER TABLE properties DROP COLUMN IF EXISTS review_utility_bills;
ALTER TABLE work_trade_agreements
  ADD COLUMN IF NOT EXISTS field_permissions text[] NOT NULL DEFAULT '{}';
ALTER TABLE work_trade_agreements DROP CONSTRAINT IF EXISTS work_trade_agreements_field_permissions_check;
ALTER TABLE work_trade_agreements ADD CONSTRAINT work_trade_agreements_field_permissions_check
  CHECK (field_permissions <@ ARRAY['read_meters']);
-- Curtis Clabough, Country Acres — Nic: "let's add Curtis a permission to read the meters."
UPDATE work_trade_agreements SET field_permissions = '{read_meters}'
 WHERE id = '9f96f897-a4d5-40f8-b3f1-bc4f30ff79fe';
