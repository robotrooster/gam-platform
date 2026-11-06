-- 11/5 (Nic) — THE WALK-AWAY DEBT IS KEYED ON THE PERSON, NOT THE LEASE.
--
--   "We need a way for it to only record once, but it needs to be able to be
--    infused from different sources."
--
-- services/leftOwingFreeze was written this morning keyed on the LEASE, which
-- made a second record for a debt services/leftOwingCollection had already
-- written against the person — the two collided the moment a deposit return was
-- finalised, and the deposit-return suite caught it. Both now write
-- 'carried:<tenant>:<landlord>', the key leftOwingCollection has used since
-- 10/27, so a tenancy ending and a deposit return coming up short land on ONE
-- record.
--
-- BACKFILL: required, and this is the whole point of the migration. Two live
-- records carry a lease id as their key — Country Acres MH 18 (Kyra Smith,
-- $1,252.80) and MH 28 (Susie McCoy, $1,507.25), neither with anything
-- collected. Left alone, the new code would not recognise them and would open a
-- SECOND record for each of those people the next time anything ran. They are
-- re-keyed onto the person here.
--
-- The person is the lease's primary resident, chosen the same way
-- leftOwingFreeze chooses them, so the key this writes and the key the code
-- looks for are produced by one rule.
--
-- SAFE: a row whose key is already 'carried:…' is left alone, and a re-key that
-- would collide with an existing record for the same person and landlord is
-- skipped rather than forced — merging two real debts is a money decision, not
-- a migration's to make. Nothing is deleted.

UPDATE tenant_left_owing o
   SET source_key = 'carried:' || who.tenant_id::text || ':' || o.landlord_id::text,
       updated_at = NOW()
  FROM (
    SELECT lo.id AS owing_id,
           (SELECT lt.tenant_id
              FROM lease_tenants lt
             WHERE lt.lease_id::text = lo.source_key
               AND lt.status IN ('active', 'pending_add', 'removed')
             ORDER BY (lt.role = 'primary') DESC, lt.created_at
             LIMIT 1) AS tenant_id
      FROM tenant_left_owing lo
     WHERE lo.source_kind = 'lease'
       AND lo.source_key !~ '^carried:'
       -- Only a key that really is a lease id: anything else is not ours to touch.
       AND lo.source_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) AS who
 WHERE o.id = who.owing_id
   AND who.tenant_id IS NOT NULL
   -- Never collide with a record that already exists for this person.
   AND NOT EXISTS (
     SELECT 1 FROM tenant_left_owing x
      WHERE x.landlord_id = o.landlord_id
        AND x.source_kind = 'lease'
        AND x.source_key = 'carried:' || who.tenant_id::text || ':' || o.landlord_id::text
        AND x.id <> o.id);
