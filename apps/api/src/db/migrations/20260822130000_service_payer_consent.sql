-- S616 (Nic) — what stops a landlord billing a stranger?
--
--   "How am I as a landlord going to set up the initial 'hey, let's bill
--    utilities to this random address' and email [them]... without any sort of
--    [check], what else are we missing?"
--
-- This was missing, and he found it by asking. S615's create flow takes a name,
-- an email and an address, opens a portal account for that person and starts
-- invoicing them — and NOTHING anywhere checked whether they ever agreed to be
-- billed. Every other route onto the platform requires the person to accept an
-- invite before anything happens to them; this one skipped it entirely.
--
-- A serviced space is the one case where the payer has no lease, no application
-- and no prior relationship with GAM. That makes consent MORE important here,
-- not less: an invoice is the first thing they would ever hear from us.
--
-- TWO WAYS TO SATISFY IT, because the real world got there first:
--   1. They accept their portal invite. They have an account, they logged in,
--      they saw what they are being billed for.
--   2. The landlord attests that they already agreed off-platform. Nic has been
--      collecting that $75 by hand for years — the arrangement is real and
--      predates GAM, and refusing to bill it until the neighbour clicks an
--      email would make the platform worse than the paper it replaces. The
--      attestation records WHO said so and WHEN, so it is a claim on the record
--      rather than a silent default.
--
-- Until one of them is true, charges still ACCRUE — the meter turned and the
-- service happened, and a bill nobody sent is not a bill nobody owes — but no
-- invoice is issued and the landlord is told plainly why.

ALTER TABLE utility_service_agreements
  ADD COLUMN IF NOT EXISTS payer_accepted_at        timestamptz,
  ADD COLUMN IF NOT EXISTS payer_attested_at        timestamptz,
  ADD COLUMN IF NOT EXISTS payer_attested_by        uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS payer_attestation_note   text;

COMMENT ON COLUMN utility_service_agreements.payer_accepted_at IS
  'S616: when the payer accepted their portal invite. Either this or '
  'payer_attested_at must be set before any invoice is issued — nobody is '
  'billed by GAM without having agreed to be.';
COMMENT ON COLUMN utility_service_agreements.payer_attested_at IS
  'S616: when the LANDLORD attested that this person already agreed to the '
  'arrangement off-platform. For the arrangements that predate GAM — cash '
  'collected by hand for years. Recorded with who attested, because it is a '
  'claim someone made rather than something the platform verified.';
