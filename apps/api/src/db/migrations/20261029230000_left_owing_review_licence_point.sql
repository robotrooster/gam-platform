-- The match-review CHECK learns the licence, which the matcher started using
-- the same day.
--
-- WHY THIS IS ITS OWN MIGRATION AND NOT A NOTE: the matcher gained a fourth
-- match point ('licence'), this constraint still allowed three, and the insert
-- that raises a close call for a person to look at is wrapped in a catch — so
-- the violation was silent and the review simply never appeared. The flag said
-- "not them" and nobody was ever asked. The catch now logs, and the allowed
-- values come from LEFT_OWING_MATCH_POINTS in packages/shared so the next
-- point added has one place to change.
--
-- No backfill: this widens what is allowed and rejects nothing already stored.

ALTER TABLE tenant_left_owing_match_reviews
  DROP CONSTRAINT IF EXISTS tenant_left_owing_match_reviews_matched_on_check;

ALTER TABLE tenant_left_owing_match_reviews
  ADD CONSTRAINT tenant_left_owing_match_reviews_matched_on_check
  CHECK (matched_on = ANY (ARRAY['account'::text, 'licence'::text, 'email'::text, 'phone'::text]));
