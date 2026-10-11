-- S652: a cancellation stamps its own time, whatever code did the cancelling.
--
-- Nights are exempt from GAM's fee only when the cancellation landed before
-- arrival, which makes `cancelled_at` load-bearing: a row that forgets it is
-- either a landlord billed for a stay that never happened, or a free month for
-- the asking, depending on which way the missing value is read. Neither is
-- acceptable, and "remember to set it" is not a guarantee — there are two call
-- sites today and no promise about the third.
--
-- So the database sets it. Same posture as the units rules: enforce it once
-- where nothing can route around it, rather than auditing every call site
-- forever. Scripts, backfills and future endpoints are all covered by
-- construction.
--
-- Un-cancelling clears it, so a booking reinstated and later cancelled again is
-- judged on the SECOND cancellation — which is the one that happened.

CREATE OR REPLACE FUNCTION fn_unit_bookings_stamp_cancelled_at()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'cancelled' AND NEW.cancelled_at IS NULL THEN
    NEW.cancelled_at := NOW();
  ELSIF NEW.status <> 'cancelled' THEN
    NEW.cancelled_at := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_unit_bookings_stamp_cancelled_at ON unit_bookings;
CREATE TRIGGER trg_unit_bookings_stamp_cancelled_at
  BEFORE INSERT OR UPDATE OF status ON unit_bookings
  FOR EACH ROW EXECUTE FUNCTION fn_unit_bookings_stamp_cancelled_at();
