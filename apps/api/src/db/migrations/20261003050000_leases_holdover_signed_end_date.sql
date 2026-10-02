-- A held-over lease keeps the end date the household SIGNED.
--
-- Decisions 10/2 #7: a signed fixed term whose landlord-signed new lease starts
-- later than the day after the term ends HOLDS OVER — at the old rent — until
-- the day before the new start. The holdover is written by moving the lease's
-- end_date (renewalSuccessor.holdOverUntilNewLeaseStarts), because every
-- consumer (the bill run, the lease-end job, the schedule) already honors
-- end_date. But that left nothing saying where the signed term really ended:
-- a household that signed through October 1 and held over to October 31 was
-- then told, if the new lease was canceled and another sent, that it was "on a
-- signed lease through October 31"; the park-wide sender said "Signed through
-- October 31"; and the next new lease's default term was measured from the
-- held-over end, so it grew by the holdover.
--
--   holdover_signed_end_date — the end date the household signed, set the first
--   time the lease holds over past it (a second holdover keeps the original).
--   NULL on every lease that has never held over.
--
-- Read by: renewalSuccessor.assertNewLeaseDates (a new lease is refused only
-- inside the SIGNED term), routes/esign.ts planNewLeaseBatch (its reason and
-- note) and draftNewLeaseForHousehold (the next draft's term length), and the
-- landlord's new-lease window and Leases page wording.
--
-- Same shape as move_out_notice_prev_end_date (S653), which keeps the end date
-- a leaving date replaced.
--
-- EXPAND ONLY. Nullable, no default. No backfill needed: production has no
-- landlord-signed new lease waiting, so no lease is holding over. Safe to drop.

ALTER TABLE leases
  ADD COLUMN IF NOT EXISTS holdover_signed_end_date date;

COMMENT ON COLUMN leases.holdover_signed_end_date IS
  'S655 (decisions 10/2 #7): the end date the household signed, kept when the lease holds over past it until its new lease starts (end_date then reads the held-over day). NULL = never held over.';
