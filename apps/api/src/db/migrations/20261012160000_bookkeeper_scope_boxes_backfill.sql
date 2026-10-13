-- 10/11 (Nic) — EVERY PROPERTY IS ITS OWN BOX: WRITE OUT THE OLD "ALL"
--
--   Bookkeeper access is per property. Nothing ticked is refused. A property
--   added or transferred in later appears unticked. A stored NULL no longer
--   means "all".
--
-- 20261011120000 stored a bookkeeper who keeps every property as
-- bookkeeper_scopes.property_ids NULL. That reading cannot survive the new
-- rule: NULL would quietly hand them every property the company buys from now
-- on, when a new property must arrive unticked. The code no longer writes NULL
-- (routes/scopes refuses an empty choice), and until this runs it still reads
-- an old NULL row as "every property" (lib/bookkeeperScope, the expand window)
-- so nobody lost access at the deploy.
--
-- This turns each NULL row into what it meant on the day it was written out:
-- every property the company owns today, ticked one by one. From then on a
-- property the company adds is not in the list, so it starts unticked.
--
-- Pending bookkeeper invitations get the same treatment: an invitation whose
-- scope_payload names no properties (missing, null or []) is given the
-- company's properties, so accepting it grants what the owner meant when it
-- was sent. An invitation for a company with no property yet is left alone; it
-- is refused when accepted ("names no properties"), which is right — a company
-- with no property cannot have a bookkeeper.
--
-- A NULL row whose company owns no property cannot be written out (an empty
-- list is not allowed, and there is nothing to tick), so the migration stops
-- and says so rather than guessing.
--
-- Backfill: this file IS the backfill. Production had 0 bookkeeper_scopes rows
-- and 0 pending bookkeeper invitations on 10/11, so it moves nothing there
-- today; it exists for gam_demo and any row written before the deploy.
-- Next step (a separate migration, after this has run everywhere): make
-- property_ids NOT NULL and require at least one id; then drop the NULL
-- branch from lib/bookkeeperScope.
--
-- ORDER (this one is not migrations-first). The old live API still writes
-- property_ids NULL rows and propertyIds:null invitations, so a backfill run
-- before it is replaced leaves fresh NULLs behind: the new code then refuses
-- those invitations ("names no properties") and the NOT NULL step fails on
-- them. Ship in this order:
--   1. the API (it fails closed: the old Team page's invites and edits that
--      send no properties are refused, and an old NULL row still reads as
--      every property, so nobody loses access);
--   2. this backfill;
--   3. the landlord frontend (an old API ignores the new Team page's
--      DELETE ?landlordId= and would remove a bookkeeper from every company of
--      the account);
--   4. re-run this file (it is idempotent) right before the NOT NULL contract
--      migration, to catch anything written in between.
-- Production had 0 rows and 0 pending invitations on 10/11, so today this is
-- ordering only.
-- Safe drop: not applicable (data only). Re-running is a no-op.

DO $$
DECLARE stranded int;
BEGIN
  SELECT count(*) INTO stranded
    FROM bookkeeper_scopes bs
   WHERE bs.property_ids IS NULL
     AND NOT EXISTS (SELECT 1 FROM properties p WHERE p.landlord_id = bs.landlord_id);
  IF stranded > 0 THEN
    RAISE EXCEPTION
      '% bookkeeper_scopes row(s) mean "every property" for a company that owns no property; decide them by hand before this backfill',
      stranded;
  END IF;
END $$;

UPDATE bookkeeper_scopes bs
   SET property_ids = ARRAY(SELECT p.id FROM properties p
                             WHERE p.landlord_id = bs.landlord_id
                             ORDER BY p.created_at, p.id),
       updated_at = NOW()
 WHERE bs.property_ids IS NULL;

UPDATE invitations i
   SET scope_payload = jsonb_set(i.scope_payload, '{propertyIds}',
         (SELECT jsonb_agg(p.id ORDER BY p.created_at, p.id)
            FROM properties p WHERE p.landlord_id = i.landlord_id))
 WHERE i.role = 'bookkeeper'
   AND i.status = 'pending'
   AND (CASE jsonb_typeof(i.scope_payload->'propertyIds')
          WHEN 'array' THEN jsonb_array_length(i.scope_payload->'propertyIds') = 0
          ELSE TRUE
        END)
   AND EXISTS (SELECT 1 FROM properties p WHERE p.landlord_id = i.landlord_id);
