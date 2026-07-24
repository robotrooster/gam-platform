-- S550 (Nic): first-party product analytics — which pages and features
-- actually get used, per portal, per role. The behavioral dataset a
-- platform acquirer pays for, and the one thing that can never be
-- reconstructed later. Self-hosted (no external analytics — house rule);
-- event rows are append-only.
-- No backfill possible: history starts now.

CREATE TABLE product_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  portal text NOT NULL,             -- 'tenant' | 'landlord' | 'admin' | ...
  event text NOT NULL,              -- 'page_view' | future feature events
  path text,                        -- route path for page_view
  user_id uuid,                     -- NULL for anonymous/public pages
  role text,
  landlord_id uuid,
  meta jsonb
);

CREATE INDEX product_events_occurred_idx ON product_events (occurred_at);
CREATE INDEX product_events_portal_event_idx ON product_events (portal, event, occurred_at);
CREATE INDEX product_events_user_idx ON product_events (user_id, occurred_at);
