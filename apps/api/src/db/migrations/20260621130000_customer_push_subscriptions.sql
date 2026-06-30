-- Customer Web Push subscriptions (service-business, S510).
--
-- WHY: customers opt into browser push notifications from the portal so
-- they're alerted "you're next" / "completed" / "couldn't service you"
-- even when the portal tab is closed. No SMS/email — Web Push only,
-- which is free. One row per device the customer enables; a customer can
-- have several. Sends that come back 404/410 (expired) get the row
-- deleted by the sender.
--
-- endpoint is the push service URL (unique per device subscription);
-- p256dh + auth are the subscription's encryption keys. No backfill.

CREATE TABLE customer_push_subscriptions (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES business_customers(id) ON DELETE CASCADE,
  endpoint    text NOT NULL UNIQUE,
  p256dh      text NOT NULL,
  auth        text NOT NULL,
  created_at  timestamp with time zone DEFAULT now() NOT NULL,
  last_used_at timestamp with time zone
);

CREATE INDEX idx_customer_push_subs_customer ON customer_push_subscriptions (customer_id);
