-- S115: stripe_connect_status_synced_at — last time GAM observed an
-- account.updated webhook for this entity's Connect account. Used by the
-- dashboard to show "Stripe state last refreshed N seconds ago" and as a
-- liveness signal if Stripe webhooks ever stop firing.
--
-- Could be inferred by querying Stripe each time, but that's a round-trip
-- per page load. Snapshotting the timestamp on webhook receipt is cheap
-- and makes the UI fast.

ALTER TABLE users
  ADD COLUMN stripe_connect_status_synced_at timestamp with time zone;

ALTER TABLE pm_companies
  ADD COLUMN stripe_connect_status_synced_at timestamp with time zone;
