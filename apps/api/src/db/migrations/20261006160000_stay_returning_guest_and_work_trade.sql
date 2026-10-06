-- 10/6 (Nic) — RETURNING GUESTS AND WORK TRADE ON A STAY
--
--   "I need a way when I'm manually adding a reservation by hand to confirm
--    that that person's been here before... I need to verify that the system
--    is not going to try to do a background check on them."
--
--   "Can I mark somebody as work trade through the reservation flow? Hey,
--    they're going to be staying for two months. Mark them as work trade. Boom."
--
-- 1. unit_bookings.returning_guest_at / returning_guest_by — the landlord's
--    attestation, on the stay, that the guest has stayed at this property
--    before (who and when). A stay of 22+ continuous nights carrying it needs
--    no background check: no fee, no check link, check-in never waits on
--    screening. Later legs of the same continuous stay inherit it (stayTerms
--    continuousStayNights). It draws on the SAME rolling-year returning-
--    resident allowance as an invite (services/onboardingWindow): 25% of the
--    property's sites, counted as DISTINCT people attested at the property in
--    the last 365 days, by invite or by reservation — so a person attested
--    once is returning again for free all year.
--
-- 2. work_trade_agreements.booking_id — a work trade made for a STAY. The
--    agreement is the guest's, on the stay's site, for the stay's dates (start
--    = check-in, end = check-out), and it follows the stay: extended,
--    shortened, moved to another site, checked out early or cancelled
--    (services/stayWorkTrade syncStayWorkTrade). A lease drafted from the stay
--    takes the agreement over: booking_id is cleared and it runs with the
--    lease. One agreement per stay (partial unique index).
--
-- Backfill: none. No stay has either today; every existing row reads NULL.
-- Safe drop: the three columns and the index (nothing else depends on them).

ALTER TABLE public.unit_bookings
  ADD COLUMN IF NOT EXISTS returning_guest_at timestamptz,
  ADD COLUMN IF NOT EXISTS returning_guest_by uuid REFERENCES public.users(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.unit_bookings.returning_guest_at IS
  '10/6 (Nic): when the landlord attested the guest has stayed at this property before. A 22+ night stay carrying it needs no background check; it counts against the property''s rolling-year returning-resident allowance (one count per person per year).';
COMMENT ON COLUMN public.unit_bookings.returning_guest_by IS
  '10/6 (Nic): who attested the guest is returning (an owner or a staff member allowed to skip the background check).';

ALTER TABLE public.work_trade_agreements
  ADD COLUMN IF NOT EXISTS booking_id uuid REFERENCES public.unit_bookings(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.work_trade_agreements.booking_id IS
  '10/6 (Nic): the stay this work trade was made for. Its dates and site follow the stay; a lease drafted from the stay takes it over (cleared).';

CREATE UNIQUE INDEX IF NOT EXISTS work_trade_agreements_booking_uniq
  ON public.work_trade_agreements (booking_id) WHERE booking_id IS NOT NULL;
