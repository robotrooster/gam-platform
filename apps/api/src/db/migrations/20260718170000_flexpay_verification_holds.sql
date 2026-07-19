-- S545c (Nic): silent verification holds on FlexPay requests.
--
-- Two fraud gates:
--   1. NAME: the proof-of-benefits document must be in the name of at
--      least one lease holder — enforced at approval (reviewer must
--      affirmatively confirm; lease-holder names shown in the modal).
--   2. BIRTHDATE: an SSDI Wednesday claim implies the recipient's
--      birth-date range (1st-10th → 2nd Wed, 11th-20th → 3rd Wed,
--      21st-31st → 4th Wed). If NO lease holder's date_of_birth is
--      consistent with the claimed schedule, the request is SILENTLY
--      held: removed from the working queue, zero tenant-facing
--      change (their card still shows the normal pending copy).
--
-- held_at IS NOT NULL = held. Status stays 'pending' so release is
-- just clearing these columns — created_at is untouched, so the
-- float+FIFO ordering restores their original spot in line
-- automatically ("jump back to their place").
--
-- No backfill needed.

ALTER TABLE flexpay_inquiries
  ADD COLUMN held_at     timestamptz,
  ADD COLUMN hold_reason text;
