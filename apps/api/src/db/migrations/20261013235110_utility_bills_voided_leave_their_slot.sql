-- 10/12 (Nic, G8) — KEEP EVERYTHING: A UTILITY BILL ON A TENANCY THAT NEVER
-- HAPPENED IS VOIDED, NOT DELETED.
--
-- Two places still DELETEd a utility_bills row (lib/unwindIssuedLease): a lease
-- voided before the tenant signed, and the move-in bill closed because the
-- tenant never moved in. In both, the usage is real and goes back on hold
-- (suspended_utility_charges) for whoever the space is billed to next, and the
-- bill was deleted to take it "out of its one-per-meter-per-cycle slot" — the
-- next tenant's bill for the same meter, space and month would otherwise
-- collide with it. The row, and what it said, went with it.
--
-- Now the bill is kept: status 'void' (already allowed), with
--   voided_at   — when it was taken back
--   void_reason — why, in plain words
-- and a bill voided this way LEAVES the slot: the one-per-cycle rule becomes a
-- unique index over bills that are not voided-out (voided_at IS NULL).
--
-- The older 'void' bills (a paused cycle's $0 marker, a meter repair's voided
-- estimate) carry no voided_at and keep their slot exactly as before — they
-- mark a cycle that must not be billed again. Only a void that stamps
-- voided_at gives the slot up.
--
-- Every inserter of utility_bills uses an untargeted ON CONFLICT DO NOTHING
-- or catches 23505 (services/utilityBilling, scripts), which a partial unique
-- index serves exactly as the constraint did; none names the constraint. The
-- index keeps the constraint's name so an error still reads the same.
--
-- Expand-only: the rule only gets less strict, and only for rows that carry
-- voided_at, which nothing writes before the code ships. No backfill.
-- Safe drop: put the UNIQUE constraint back (fails only if a voided-out bill
-- shares a slot with a live one).

ALTER TABLE utility_bills
  ADD COLUMN IF NOT EXISTS voided_at   timestamptz,
  ADD COLUMN IF NOT EXISTS void_reason text;

ALTER TABLE utility_bills DROP CONSTRAINT IF EXISTS utility_bills_voided_is_stamped;
ALTER TABLE utility_bills ADD CONSTRAINT utility_bills_voided_is_stamped
  CHECK ((voided_at IS NULL) = (void_reason IS NULL)
         AND (voided_at IS NULL OR (status = 'void' AND payment_id IS NULL)));

ALTER TABLE utility_bills DROP CONSTRAINT IF EXISTS utility_bills_one_per_meter_unit_cycle;
DROP INDEX IF EXISTS utility_bills_one_per_meter_unit_cycle;
CREATE UNIQUE INDEX utility_bills_one_per_meter_unit_cycle
  ON utility_bills (meter_id, unit_id, billing_cycle_month, utility_type)
  WHERE voided_at IS NULL;

COMMENT ON COLUMN utility_bills.voided_at IS
  '10/12 (G8): when this bill was voided out of its cycle slot (a tenancy that never happened; the usage went back on hold). Kept forever; owed by nobody. NULL on every other bill, including the older $0 void markers, which keep their slot.';
COMMENT ON COLUMN utility_bills.void_reason IS
  '10/12 (G8): why the bill was voided out of its slot, in plain words.';
COMMENT ON INDEX utility_bills_one_per_meter_unit_cycle IS
  'One bill per meter, space, month and utility — over bills not voided out of their slot (voided_at IS NULL, 10/12).';
