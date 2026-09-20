-- S652: when a booking was cancelled, not just that it was.
--
-- Nights bill in arrears and the accrual runs on the 1st, and the billable
-- query excluded any booking whose status was 'cancelled' or 'no_show' with no
-- check on WHEN that happened. So a guest could stay all month, pay the park,
-- and the booking be cancelled on the 30th — the nights vanished from GAM's
-- bill, and nothing recorded that the flip had happened after the fact.
--
-- Nic's rule: "If somebody cancels that stay prior to the date of the
-- reservation, then those nights don't get counted for the aggregate. We're
-- only billing for what people were genuinely there for, and if the reservation
-- was never cancelled, we have no way to know." And the cutoff, settled after
-- thinking about it out loud: "before check-in day, the day before check-in."
--
-- NO-SHOW IS GONE FROM THE BILLING TEST ENTIRELY. Nic: "I don't want to have a
-- no-show thing. If they just don't show up, that's not really GAM's problem."
-- A site held for somebody who never turned up was still held — it could not be
-- sold to anybody else, and the schedule tracked it all the way through, which
-- is the thing GAM is paid for. The status stays for the landlord's own records;
-- it just stops deciding what GAM bills.

ALTER TABLE unit_bookings
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;

COMMENT ON COLUMN unit_bookings.cancelled_at IS
  'S652: when the cancellation happened. Nights are exempt from the platform fee only when this is strictly before check_in — a stay cancelled on or after arrival was a stay.';

-- Existing cancelled rows have no recorded moment. Treating them as cancelled
-- in time is the generous reading and the honest one: nobody was told the
-- timing mattered while they were doing it, and back-billing a landlord under a
-- rule that did not exist when they acted is not a thing GAM does.
UPDATE unit_bookings
   SET cancelled_at = COALESCE(cancelled_at, check_in::timestamptz - INTERVAL '1 day')
 WHERE status = 'cancelled' AND cancelled_at IS NULL;
