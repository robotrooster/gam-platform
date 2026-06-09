-- S255: deposit_returns.status adds 'sent_carried_forward' for the
-- portability path. When a tenant authorizes carry-forward to a
-- new GAM lease at termination time, finalize uses this status
-- instead of sent_refund/sent_gap.

ALTER TABLE deposit_returns DROP CONSTRAINT IF EXISTS deposit_returns_status_check;
ALTER TABLE deposit_returns
  ADD CONSTRAINT deposit_returns_status_check
    CHECK (status = ANY (ARRAY[
      'draft',
      'sent_refund',
      'sent_gap',
      'sent_zero',
      'sent_carried_forward',
      'disputed'
    ]));
