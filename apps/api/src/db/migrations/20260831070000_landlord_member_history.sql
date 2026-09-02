-- S631 (Nic): "What happened to my other partner Blu that was a co-owner of Oak
-- Park that I had already added? He seems to have disappeared from the list."
--
-- He had been one. The invitation was sent 2026-08-24 19:04, he registered at
-- 19:07 and accepted at 19:12, which wrote a real landlord_members row. On
-- 2026-08-28 17:31 that row was gone and his invitation read 'revoked' — three
-- minutes before Mountain View RV Park Ranch LLC was created, during an evening
-- of entity restructuring.
--
-- WHY NOBODY CAN SAY WHO DID IT. Removing a co-owner was a hard DELETE with no
-- audit row, and no application path writes 'revoked' to that invitations table
-- at all. The DELETE endpoint also notifies the removed owner — Blu has no such
-- notification — so this did not go through the app. It was a direct database
-- edit, and the schema kept nothing that could name it.
--
-- Two things were wrong and this fixes both.
--
-- 1. GAM NEVER ERASES (standing directive). A membership that existed is a fact
--    about who could see a portfolio's money, and losing it loses the ability to
--    answer exactly the question above.
-- 2. APP-LEVEL LOGGING WOULD NOT HAVE CAUGHT THIS. The edit bypassed the app, so
--    the record has to be written by the DATABASE. A trigger sees a hand-run
--    DELETE, a migration, and a future endpoint nobody has written yet, which is
--    the only way this is actually covered.
--
-- landlord_members stays the live-membership table, untouched, so all eighteen
-- readers across auth, scope, properties, transfers and the bank feed remain
-- correct by construction — no filter for one of them to forget, which is how a
-- removed owner would silently keep access.
CREATE TABLE IF NOT EXISTS landlord_member_history (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  landlord_id  uuid NOT NULL,
  user_id      uuid NOT NULL,
  action       text NOT NULL CHECK (action IN ('added', 'removed')),
  role         text,
  -- Who the row said added them; NULL on a removal, which the trigger cannot
  -- attribute (a database trigger has no request user). That NULL is itself
  -- informative: it means the change did not come through an endpoint that
  -- recorded an actor.
  added_by_user_id uuid,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  db_user      text NOT NULL DEFAULT current_user,
  application  text
);

CREATE INDEX IF NOT EXISTS landlord_member_history_by_landlord
  ON landlord_member_history (landlord_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS landlord_member_history_by_user
  ON landlord_member_history (user_id, occurred_at DESC);

COMMENT ON TABLE landlord_member_history IS
  'S631: append-only record of every co-owner added to or removed from an entity, written by trigger so a direct database edit is captured too.';

CREATE OR REPLACE FUNCTION landlord_members_history() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO landlord_member_history
      (landlord_id, user_id, action, role, added_by_user_id, application)
    VALUES (NEW.landlord_id, NEW.user_id, 'added', NEW.role, NEW.added_by_user_id,
            current_setting('application_name', true));
    RETURN NEW;
  ELSE
    INSERT INTO landlord_member_history
      (landlord_id, user_id, action, role, added_by_user_id, application)
    VALUES (OLD.landlord_id, OLD.user_id, 'removed', OLD.role, NULL,
            current_setting('application_name', true));
    RETURN OLD;
  END IF;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_landlord_members_history ON landlord_members;
CREATE TRIGGER trg_landlord_members_history
  AFTER INSERT OR DELETE ON landlord_members
  FOR EACH ROW EXECUTE FUNCTION landlord_members_history();

-- Backfill what can still be established: every membership that exists now, and
-- the one accepted co-owner invitation whose membership no longer does.
INSERT INTO landlord_member_history (landlord_id, user_id, action, role, added_by_user_id, occurred_at, db_user, application)
SELECT lm.landlord_id, lm.user_id, 'added', lm.role, lm.added_by_user_id, lm.created_at,
       'backfill', 'S631 backfill — existing membership'
  FROM landlord_members lm
 WHERE NOT EXISTS (SELECT 1 FROM landlord_member_history h
                    WHERE h.landlord_id = lm.landlord_id AND h.user_id = lm.user_id);

INSERT INTO landlord_member_history (landlord_id, user_id, action, role, occurred_at, db_user, application)
SELECT i.landlord_id, i.accepted_user_id, 'added', 'owner', i.accepted_at,
       'backfill', 'S631 backfill — accepted invitation, membership since gone'
  FROM landlord_member_invitations i
 WHERE i.accepted_at IS NOT NULL AND i.accepted_user_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM landlord_members lm
                    WHERE lm.landlord_id = i.landlord_id AND lm.user_id = i.accepted_user_id)
   AND NOT EXISTS (SELECT 1 FROM landlord_member_history h
                    WHERE h.landlord_id = i.landlord_id AND h.user_id = i.accepted_user_id);
