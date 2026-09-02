-- S634 (Nic, DIRECTIVE): "Remove the landlord ID column so it doesn't creep its
-- way back in accidentally."
--
-- `users.active_landlord_id` was the answer to a question that no longer exists:
-- "which one of my companies is this session in?" An account owns companies and
-- is signed into all of them at once (S633) — there is no active entity, no
-- switcher, nothing to be "in".
--
-- WHY DROP IT RATHER THAN LEAVE IT UNREAD. A nullable column named
-- active_landlord_id, sitting on `users`, next to a FK to `landlords`, is an
-- invitation. The next person reading this schema — or the next session of mine
-- — sees it and reaches for it, and the moment anything filters on it we are
-- back to a landlord who owns two companies being half signed in, which is a
-- failure that returns an empty list instead of an error. Nic is right that the
-- cheapest way to keep it from creeping back is for it not to be there.
--
-- NOTHING READS IT. Verified before writing this: the login query no longer
-- joins `landlords` at all, /auth/me resolves the account's companies through
-- `landlord_members` UNION founding ownership, and the two remaining writes
-- (create-entity, accept-co-owner-invite) are gone — both were only ever
-- setting which entity to sit on.
--
-- NO BACKFILL NEEDED, AND NOTHING IS LOST. Membership is the real record and
-- lives in `landlord_members`; every value this column held is derivable from
-- it. The one production row that had a non-null value was a workaround set by
-- hand in S632 so an invite could be sent — exactly the thing this release
-- makes unnecessary.
--
-- The index and FK go with it automatically, but they are dropped explicitly so
-- reading this migration tells the whole story.
DROP INDEX IF EXISTS users_active_landlord_idx;

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_active_landlord_id_fkey;

ALTER TABLE users
  DROP COLUMN IF EXISTS active_landlord_id;
