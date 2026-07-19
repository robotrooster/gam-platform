-- S547: short-term guests can reserve common areas (Nic).
--
-- A guest with a week-long stay may want the clubhouse for a birthday
-- party, but they're not a tenant — no tenant portal, no user account.
-- Guest reservations come in from the property's public website, keyed to
-- their stay (unit_bookings row, matched by the email on the reservation).
--
-- created_by_user_id becomes nullable: a guest has no user. Integrity is
-- kept by the CHECK — every reservation is attributable to EITHER a
-- platform user (tenant/staff path) OR a guest stay.
--
-- No backfill needed (existing rows all carry created_by_user_id).

ALTER TABLE common_area_reservations
  ADD COLUMN guest_booking_id uuid REFERENCES unit_bookings(id) ON DELETE SET NULL,
  ALTER COLUMN created_by_user_id DROP NOT NULL,
  ADD CONSTRAINT common_area_reservations_actor_check
    CHECK (created_by_user_id IS NOT NULL OR guest_booking_id IS NOT NULL);

CREATE INDEX ix_common_area_reservations_guest_booking
  ON common_area_reservations(guest_booking_id) WHERE guest_booking_id IS NOT NULL;
