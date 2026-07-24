-- Raw Stripe webhook event storage (OAK_PARK_LAUNCH C3, S550 data-completeness).
-- WHY: webhook processing logic changes over time; if we only keep the
-- *effects* of processing, history can never be replayed under corrected
-- logic. Storing every verified event payload append-only means any future
-- processing bug is recoverable: replay the raw events. This is the same
-- "the data is the asset" posture as the S550 audit journal.
--
-- Append-only by design: payload/event columns are never updated or
-- deleted; the ONLY mutable column is processing_error (a status stamp
-- written when a handler fails). stripe_event_id UNIQUE makes insertion
-- idempotent under Stripe's at-least-once delivery (retries land ON
-- CONFLICT DO NOTHING). Deliberately NOT journaled by audit_row_changes
-- (payload is immutable; the error stamp is operational, not asset data).
--
-- processing_error: NULL = handler completed; non-NULL = handler threw
-- (Stripe will retry; the raw payload is preserved either way, and the
-- error text makes "which events failed processing" a one-query report).
--
-- No backfill needed: table starts empty; history begins at first live
-- webhook delivery.

CREATE TABLE stripe_webhook_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_event_id  text NOT NULL UNIQUE,
  event_type       text NOT NULL,
  api_version      text,
  livemode         boolean NOT NULL,
  payload          jsonb NOT NULL,
  received_at      timestamptz NOT NULL DEFAULT now(),
  processing_error text
);

CREATE INDEX idx_stripe_webhook_events_type_received
  ON stripe_webhook_events (event_type, received_at);
