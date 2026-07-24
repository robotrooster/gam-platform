-- S552: applicant refund tracking for screenings that never happen.
--
-- WHY: the applicant pays GAM BEFORE the Checkr order is placed. If the
-- screening never completes — the applicant cancels, or never finishes
-- Checkr's apply flow and the order goes stale — GAM holds money for a
-- service not rendered. Several actual-cost states (MN explicitly) require
-- refunding a screening fee when no screening is performed; we refund in
-- full everywhere (one behavior, 50 states, simplest).
--
-- stripe_refund_id + refunded_at stamp the Stripe refund. NULL = nothing
-- refunded (normal completed checks, mock/dev intents, or fee-prohibited
-- states where the applicant paid $0). No backfill needed.

ALTER TABLE background_checks
  ADD COLUMN stripe_refund_id text,
  ADD COLUMN refunded_at timestamptz;
