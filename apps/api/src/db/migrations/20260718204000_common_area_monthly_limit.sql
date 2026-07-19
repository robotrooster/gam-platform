-- S547: per-person monthly reservation cap (Nic — bad-actor guard).
--
-- Stops one person (guest OR resident) squatting an amenity — e.g. booking
-- two hours at the pool every day so nobody else can. Landlord-set per
-- area: max non-cancelled reservations per person per CALENDAR MONTH.
-- NULL = unlimited (current behavior). Enforced in both the tenant request
-- path and the guest stay-link path; landlord-created holds are exempt
-- (it's their property).
--
-- No backfill needed.

ALTER TABLE common_areas
  ADD COLUMN monthly_reservation_limit integer CHECK (monthly_reservation_limit > 0);
