-- 11/5 (Nic) — THE OTHER SOURCES CAN NOW BE PARTS OF ONE DEBT.
--
--   "We need a way for it to only record once, but it needs to be able to be
--    infused from different sources. ...people have short-term stays as well.
--    Or people, 'hey, my card wasn't working when I went to buy some propane,
--    and I'm going to come back with a new card,' and they never do. That
--    wasn't a lease or a stay."
--
-- 20261105210000 built tenant_left_owing_parts and gave the record a
-- person_key, but every writer still set the parent's amount directly and a
-- stay still opened a SECOND record of its own, keyed on the booking. This
-- migration opens the two value sets the parts path needs, and the writers move
-- onto it in the same deploy (services/leftOwingParts).
--
-- TWO CHANGES, both widening a CHECK — nothing is narrowed, so no existing row
-- can be made invalid and no backfill is needed.
--
--   1. parts.kind gains 'carried'. A resident who leaves part-way through
--      collecting an EARLIER landlord's debt leaves the collecting landlord
--      having paid that landlord's share out of their own disbursement
--      (services/leftOwingCollection carryForwardOnDeparture). That money is
--      real and it is NOT the lease's unpaid rent — it is a different pot, so
--      it is its own part. Folding it into the 'lease' part would have the two
--      writers overwrite each other and lose whichever ran second.
--
--   2. tenant_left_owing.source_kind gains 'counter'. The parent's
--      source_kind/source_key are now only PROVENANCE — what first opened the
--      record — because the money lives in the parts and the identity lives in
--      person_key. A record that starts from an unpaid counter tab could not be
--      written at all while the CHECK knew only lease/stay/import.
--
-- The legacy unique (landlord_id, source_kind, source_key) STAYS. Every parent
-- written from here on keys it on the thing that opened the record — a lease
-- id, a booking id, a ticket id — which is unique per thing, so a person who
-- settles one debt and later walks away from something else gets a fresh
-- record instead of colliding with the settled one. Dropping that unique is
-- the contract half of expand-then-contract and belongs in its own migration
-- once nothing reads source_key as an identity any more
-- ([[gam-migrate-expand-then-contract]]).

ALTER TABLE tenant_left_owing_parts
  DROP CONSTRAINT IF EXISTS tenant_left_owing_parts_kind_check;
ALTER TABLE tenant_left_owing_parts
  ADD CONSTRAINT tenant_left_owing_parts_kind_check
  CHECK (kind IN ('lease', 'stay', 'counter', 'carried', 'import'));

ALTER TABLE tenant_left_owing
  DROP CONSTRAINT IF EXISTS tenant_left_owing_source_kind_check;
ALTER TABLE tenant_left_owing
  ADD CONSTRAINT tenant_left_owing_source_kind_check
  CHECK (source_kind IN ('lease', 'stay', 'counter', 'import'));
