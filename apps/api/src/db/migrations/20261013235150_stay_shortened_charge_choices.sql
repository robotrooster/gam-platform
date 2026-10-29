-- 10/12 (Nic, G6) — A STAY SHORTENED PAST RENT A PAYMENT WAS TRIED ON: THE
-- LANDLORD CHOOSES, AT THAT MOMENT.
--
-- When a stay's dates move its end earlier, unpaid rent for the nights it no
-- longer has is taken off — unless a payment was tried on it (a declined card,
-- a returned bank pull) or another record points at it. Until now that rent
-- simply stayed on the guest's account and GAM was told to "decide with the
-- landlord" (services/bookingLeaseBilling, 'stay_shortened_rent_kept').
--
-- Nic: LANDLORD'S CHOICE at the moment they shorten — void those charges
-- (refund or credit any money paid on them), or keep them owed. The schedule
-- (Edit / drag of the stay) and the Check out window ask before the save, and
-- the answer is written here with the save; the lease sync that follows
-- (syncLeaseWithBookingDates) carries it out and stamps applied_at.
--
--   booking_id / lease_id  — the stay and the lease that follows it
--   new_check_out          — the end the choice was made for (the sync only
--                            applies a choice made for the end it is moving to)
--   choice                 — 'void' or 'keep' (@gam/shared STAY_SHORTENED_CHARGE_CHOICES)
--   payment_ids            — the charges the landlord was shown; only these
--                            follow the choice
--   chosen_by / chosen_at  — who answered, and when
--   applied_at             — when the sync carried it out
--
-- No money column (the charges themselves carry the money and their own void
-- or note). Insert, then applied_at once; nothing else changes.
-- Expand-only: a new table nothing reads before the code ships.
-- Safe drop: DROP TABLE stay_shortened_charge_choices.

CREATE TABLE IF NOT EXISTS stay_shortened_charge_choices (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id     uuid NOT NULL REFERENCES unit_bookings(id),
  lease_id       uuid NOT NULL REFERENCES leases(id),
  landlord_id    uuid NOT NULL REFERENCES landlords(id),
  new_check_out  date NOT NULL,
  choice         text NOT NULL CHECK (choice IN ('void', 'keep')),
  payment_ids    uuid[] NOT NULL,
  chosen_by      uuid REFERENCES users(id),
  chosen_at      timestamptz NOT NULL DEFAULT now(),
  applied_at     timestamptz
);

CREATE INDEX IF NOT EXISTS idx_stay_shortened_charge_choices_open
  ON stay_shortened_charge_choices (booking_id, new_check_out) WHERE applied_at IS NULL;

COMMENT ON TABLE stay_shortened_charge_choices IS
  '10/12 (Nic, G6): the landlord''s answer, given when a stay was shortened, for unpaid rent on the nights it no longer has that a payment was tried on — void it (money paid on it comes back as credit) or keep it owed. Carried out by services/bookingLeaseBilling syncLeaseWithBookingDates.';
