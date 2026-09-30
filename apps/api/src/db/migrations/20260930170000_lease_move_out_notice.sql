-- S653 (Nic): "They're going to come in and say, hey, I'm pulling out Saturday
-- with like maybe three or four days notice, if that. We need the front desk to
-- be able to mark it as, hey, they're leaving then."
--
-- The mark is the lease's end_date — every consumer already honors that (the
-- schedule, reservations, invoicing, the reads-due list, the 2am lease-end job,
-- the deposit return). These columns record THAT it was a notice, when, by whom,
-- what they said, and what the end date was before, so it can be undone if they
-- change their mind. Nothing here touches any signed document.
--
-- No backfill needed: NULL = no notice recorded.
ALTER TABLE leases
  ADD COLUMN move_out_notice_at timestamptz,
  ADD COLUMN move_out_notice_by uuid REFERENCES users(id),
  ADD COLUMN move_out_notice_note text,
  ADD COLUMN move_out_notice_prev_end_date date;

COMMENT ON COLUMN leases.move_out_notice_at IS 'S653: when the front desk recorded that the resident said they are leaving. end_date is the day they said. NULL = no notice on file.';
COMMENT ON COLUMN leases.move_out_notice_prev_end_date IS 'S653: what end_date was before the notice (NULL for month-to-month), restored if the notice is called off.';
