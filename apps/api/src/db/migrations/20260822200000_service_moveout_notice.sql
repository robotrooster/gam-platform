-- S616 (Nic) — the neighbour tells us they are leaving.
--
--   "How do we track that that is actually happening? ... maybe that tenant
--    portal profile that only has the utilities gets a big button that says
--    'hey, I need my final bill because I'm moving out', and then it's gonna
--    look for more utilities to go onto a new person after that final billing
--    period or something."
--
-- The problem it solves: a serviced space's agreement names ONE payer, and when
-- that person leaves, nothing tells GAM. The meter keeps turning for whoever
-- moves in next, and the bill keeps naming somebody who has gone. Nobody is
-- watching the neighbour's front door — the only person who reliably knows is
-- the person leaving.
--
-- Deliberately a NOTICE and not a termination. The tenant says when they are
-- going; GAM bills the final period and the landlord confirms the reading and
-- the handover. Letting a payer end their own billing outright would let
-- somebody walk away from a balance by pressing a button.
--
-- Nic on the scale of this: "it's gonna be a super edge case anyway... the other
-- unit is also owned by family, and there's communication there between people
-- moving in and out." So this is the simple workaround he asked for, not a
-- tenancy lifecycle.
ALTER TABLE utility_service_agreements
  ADD COLUMN IF NOT EXISTS moveout_notice_at    timestamptz,
  ADD COLUMN IF NOT EXISTS moveout_expected_on  date,
  ADD COLUMN IF NOT EXISTS moveout_note         text,
  ADD COLUMN IF NOT EXISTS final_bill_issued_at timestamptz;

COMMENT ON COLUMN utility_service_agreements.moveout_notice_at IS
  'S616: when the payer told GAM they are leaving, from the button in their '
  'portal. A notice, not a termination — the landlord still confirms the final '
  'reading and who takes over.';
COMMENT ON COLUMN utility_service_agreements.moveout_expected_on IS
  'S616: the date the payer expects to be gone. Drives the final billing '
  'period and tells the landlord when to read the meter.';
