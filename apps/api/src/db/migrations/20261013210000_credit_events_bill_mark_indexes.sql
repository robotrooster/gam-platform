-- 10/12 (Nic): "the payment history should be a health percentage. one mark
-- per invoice."
--
-- A tenant's payment history is now ONE mark per bill (services/creditBillMarks):
-- every settle, the nightly credit run and the rebuild script look up a bill's
-- live mark by event_data->>'bill_key' (mark_basis 'invoice'), and the
-- per-line marks written before 10/12 by event_data->>'payment_id' (the settle
-- guard in services/settleHooks reads them the same way). credit_events had no
-- index on either, so each lookup read the whole ledger — fine at a few hundred
-- events, not at the 11k-unit portfolio's.
--
-- Two expression indexes. The bill-mark one is partial to bill marks (every
-- lookup names mark_basis 'invoice', so the planner can use it); the line-mark
-- one is whole (its lookups name the event types as a parameter list, which a
-- partial index's predicate cannot be proven from).
-- Expand-only: no column, constraint or row changes; safe to apply before the
-- code ships (the old code simply does not use them). No backfill needed.
-- Safe drop: DROP INDEX idx_credit_events_bill_mark, idx_credit_events_line_mark.

CREATE INDEX IF NOT EXISTS idx_credit_events_bill_mark
  ON credit_events ((event_data->>'bill_key'))
  WHERE event_data->>'mark_basis' = 'invoice';

CREATE INDEX IF NOT EXISTS idx_credit_events_line_mark
  ON credit_events ((event_data->>'payment_id'));
