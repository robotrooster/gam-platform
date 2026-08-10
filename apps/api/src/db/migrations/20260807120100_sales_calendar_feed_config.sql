-- Demo booking (S596) — the subscribe-once calendar feed.
--
-- GAM publishes a single private webcal/ICS feed of all booked sales slots;
-- the owner subscribes their calendar to it ONCE and every booking then
-- auto-appears — no emailed .ics to hand-add (Nic's pain point). The
-- unguessable token in the feed URL IS the credential; rotating it instantly
-- revokes any existing subscription. Enumeration-safe reads live in the public
-- route (bad/missing token -> 404, no distinction).
--
-- Singleton row: there is one sales calendar for the platform's single sales
-- rep today. A per-rep feed becomes a real table (rep_id FK) when a second
-- rep is added — flagged, not built.

CREATE TABLE IF NOT EXISTS sales_calendar_feed (
  id          boolean     PRIMARY KEY DEFAULT true,
  feed_token  uuid        NOT NULL DEFAULT gen_random_uuid(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sales_calendar_feed_singleton CHECK (id)
);

-- Mint the one token row now so the feed URL is stable from first boot.
INSERT INTO sales_calendar_feed (id) VALUES (true)
ON CONFLICT (id) DO NOTHING;
