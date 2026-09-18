-- S649 (Nic): "if somebody pays a 10% deposit on a week long stay, the other
-- 90% needs to generate on the day they're due to arrive." Short stays (no
-- lease) had no path that ever billed the balance after the deposit. On the
-- morning of arrival GAM now emails the guest a pay link for the rest; these
-- record that it went out and when it was paid.
-- (30+ night stays bill through their booking lease: the rest of the arrival
-- month on arrival day, then monthly — never the whole stay up front.)
-- No backfill: bookings already past arrival are not billed retroactively.
ALTER TABLE unit_bookings
  ADD COLUMN balance_pay_link_id uuid REFERENCES pos_pay_links(id),
  ADD COLUMN balance_billed_at timestamptz,
  ADD COLUMN balance_paid_at timestamptz;
