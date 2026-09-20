-- S652: an unpaid reservation holds its site with no clock on it — but it does
-- not outrank somebody who actually paid.
--
-- Nic, asked how long the counter's hold should last before the site goes back
-- on the board: "there's no timer for deposit link but if it's not paid and
-- someone else pays it boots them as unconfirmed when there's no other spaces."
--
-- Two halves, and both matter. Nobody's reservation quietly evaporates because
-- they read their email on Monday instead of Friday — a timer would have thrown
-- away real business for the crime of being slow. But a held site that nobody
-- has paid for cannot turn away a guest with a card in their hand when the park
-- is full and there is nowhere else to put them.
--
-- "When there's no other spaces" is the order of operations: MOVE the unpaid
-- guest to an equivalent free site first, and only displace them when the park
-- genuinely has nothing. Which is why this records both outcomes — a guest who
-- was moved is still coming, and a guest who was displaced needs a phone call.

ALTER TABLE unit_bookings
  ADD COLUMN IF NOT EXISTS displaced_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS displaced_reason    TEXT,
  -- The site they were on when they lost it, so the counter can say "you were
  -- on 14" rather than reconstructing it from the event log.
  ADD COLUMN IF NOT EXISTS displaced_from_unit UUID REFERENCES units(id);

COMMENT ON COLUMN unit_bookings.displaced_at IS
  'S652: when an unpaid hold yielded its site to a paid booking. Set on both outcomes — moved elsewhere, or left with no site at all.';

-- The sweep that resolves a clash looks for unpaid holds on a given unit and
-- window. Partial, because a paid or cancelled booking is never a candidate.
CREATE INDEX IF NOT EXISTS unit_bookings_unpaid_hold_idx
  ON unit_bookings (unit_id, check_in, check_out)
  WHERE status = 'tentative' AND deposit_paid_at IS NULL;
