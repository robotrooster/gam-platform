-- S511 — private calendar-feed token for the business appointments ICS feed.
--
-- WHY: walkthrough Business #7 — owners want their GAM appointments to show up
-- in Google / Apple / Outlook calendars. The chosen model (Nic) is a one-way
-- ICS subscribe feed: GAM publishes a private, auto-refreshing webcal URL the
-- owner subscribes to once. The token is the only credential on that public
-- (unauthenticated) endpoint, so it must be unguessable and rotatable. It is
-- created lazily the first time the owner opens the sync panel; null until then.
--
-- No backfill needed — existing businesses get a null token and mint one on demand.

ALTER TABLE public.businesses
  ADD COLUMN calendar_feed_token uuid;

-- Unique so a token resolves to exactly one business; partial so the many
-- null-token businesses don't collide on the index.
CREATE UNIQUE INDEX businesses_calendar_feed_token_key
  ON public.businesses (calendar_feed_token)
  WHERE calendar_feed_token IS NOT NULL;

COMMENT ON COLUMN public.businesses.calendar_feed_token IS
  'S511 secret token for the public appointments ICS feed (GET /api/public/business-calendar/:token.ics). Lazily minted; rotatable to revoke an old subscription.';
