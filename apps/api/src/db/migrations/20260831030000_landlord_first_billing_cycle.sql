-- S631 (Nic, DIRECTIVE): "Maybe we just have a toggle for the landlord. Hey,
-- when is your first billing cycle on this platform? That way the landlord can
-- manually say, hey, I'm a little bit late onboarding everybody here, or I'm
-- onboarding early — bill October first kind of thing. That way it puts it on
-- the landlord to bill the tenants correctly."
--
-- WHY A LANDLORD ANSWERS THIS AND CODE DOES NOT.
--
-- For an existing tenancy the signing date says nothing about which month GAM
-- should bill. A resident of six years signs on the 29th; whether GAM's first
-- invoice to them is this month or next depends entirely on whether the landlord
-- already collected this month off-platform — a fact that lives in the
-- landlord's records and nowhere in ours.
--
-- The previous attempt inferred it from dates and got it wrong in the exact case
-- this launch is: onboarding at the end of August with residents signing on
-- September 1st and 2nd. Inferring "mid-month signing → skip to the next cycle"
-- handed those residents September for free. There is no date arithmetic that
-- distinguishes "already paid me for September" from "owes me for September",
-- because the difference is not in the dates.
--
-- NULL means unanswered, and unanswered bills the month the lease starts in —
-- the same month the landlord is signing people up for. The signup default (set
-- in app code) is the first of the CURRENT month, since a landlord onboarding
-- today is normally billing for today's cycle.
ALTER TABLE landlords
  ADD COLUMN IF NOT EXISTS first_billing_cycle date;

COMMENT ON COLUMN landlords.first_billing_cycle IS
  'S631: the first month GAM invoices this landlord''s EXISTING tenants for (first of month). Set by the landlord at onboarding — only they know which months they already collected off-platform. NULL = bill the month each lease starts in.';

-- A first_billing_cycle is a month, not a day.
ALTER TABLE landlords
  DROP CONSTRAINT IF EXISTS landlords_first_billing_cycle_is_month;
ALTER TABLE landlords
  ADD CONSTRAINT landlords_first_billing_cycle_is_month
  CHECK (first_billing_cycle IS NULL OR date_trunc('month', first_billing_cycle) = first_billing_cycle);
