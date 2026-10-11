-- S639 (Nic): "We waived the late fees for the onboarding cycle... during this
-- onboarding cycle, because people are having difficulties getting onboarded and
-- being late was not entirely their fault, we are not having late fees during
-- this onboard cycle. But the late fee is set up correctly for future cycles."
--
-- The calculation is right and stays untouched. What was missing is a way to say
-- "not yet" — so the fees were wiped by hand once, and then came straight back,
-- because the exemption lives on the INVOICE and every invoice created after the
-- wipe was born without it. Jeremy Parker accrued $5/day for ten days on a
-- utility charge added after his invoice existed, and two more invoices created
-- today (Marci Neeld, Kevin Black) were a scheduler tick away from doing the
-- same at $45 each.
--
-- A per-landlord holiday date says it once. Invoices raised while it is in force
-- are born exempt, the accrual job skips their landlord outright, and when the
-- date passes the late-fee rules resume exactly as configured on each signed
-- lease. NULL means no holiday, which is the normal state of the world.
ALTER TABLE landlords
  ADD COLUMN IF NOT EXISTS late_fee_holiday_until date;

COMMENT ON COLUMN landlords.late_fee_holiday_until IS
  'S639: no late fee accrues for this landlord on or before this date — the onboarding grace Nic granted while residents were still being invited. NULL = normal late-fee rules. Clearing or back-dating it resumes each lease''s own configuration; it changes nothing about how fees are calculated.';
