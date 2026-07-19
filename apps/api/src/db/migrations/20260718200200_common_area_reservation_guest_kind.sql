-- S547: 'guest_reservation' kind (Nic — short-term guests book common areas).
--
-- A guest with a stay (unit_bookings) but no tenant account reserves an
-- area from the property's public website. Distinct kind so notification
-- copy and landlord surfaces can say "Guest" instead of "Resident".
-- Mirrors packages/shared COMMON_AREA_RESERVATION_KINDS (single source).
--
-- No backfill needed.

ALTER TABLE common_area_reservations
  DROP CONSTRAINT car_kind_check;
ALTER TABLE common_area_reservations
  ADD CONSTRAINT car_kind_check
  CHECK (kind = ANY (ARRAY['tenant_reservation'::text, 'private_rental'::text, 'maintenance_closure'::text, 'event'::text, 'guest_reservation'::text]));
