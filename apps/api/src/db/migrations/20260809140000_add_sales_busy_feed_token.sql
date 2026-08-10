-- Family / assistant "free-busy" subscribe feed (S598).
--
-- A second, independently-revocable token on the singleton sales calendar feed.
-- Subscribers using THIS token get the SAME call time-blocks as the owner's
-- feed, but with every prospect detail stripped — no name, email, phone, survey
-- brief, or Jitsi join link. Each event is just "Busy — GAM Demo" over the call
-- window, so a spouse / assistant can see WHEN the rep is on a call (and not
-- interrupt) without ever seeing a prospect's personal data on their own
-- device. Rotating this token does not affect the owner's full-detail token,
-- and vice-versa.
--
-- Safe: additive column with a minted default on the single existing row
-- (no backfill, no reader of the old shape breaks — it only SELECTs feed_token).

ALTER TABLE sales_calendar_feed
  ADD COLUMN IF NOT EXISTS busy_feed_token uuid NOT NULL DEFAULT gen_random_uuid();
