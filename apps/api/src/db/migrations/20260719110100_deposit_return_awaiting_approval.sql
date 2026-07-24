-- S548: 'awaiting_approval' deposit-return status (Nic).
--
-- A staff-initiated finalize whose refund exceeds the landlord's
-- deposit_return_approval_threshold parks here instead of paying out;
-- the landlord's finalize releases it. No shared enum exists for these
-- statuses — this CHECK is the single source.
--
-- No backfill needed.

ALTER TABLE deposit_returns
  DROP CONSTRAINT deposit_returns_status_check;
ALTER TABLE deposit_returns
  ADD CONSTRAINT deposit_returns_status_check
  CHECK (status = ANY (ARRAY['draft'::text, 'awaiting_approval'::text, 'sent_refund'::text, 'sent_gap'::text, 'sent_zero'::text, 'sent_carried_forward'::text, 'disputed'::text]));
