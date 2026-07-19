-- S547: monthly-stay deposit rule (Nic).
--
-- Nobody prepays 25% of a six-month stay. The percentage deposit
-- (booking_deposit_pct) now applies ONLY to short stays (<30 nights) —
-- guests likelier to no-show without money down. Monthly-tier stays
-- (30+ nights) owe AT MOST one month: this column is an optional flat
-- dollar override; NULL = default to one month's rate for the site type.
--
-- No backfill needed (NULL = the default one-month behavior).

ALTER TABLE properties
  ADD COLUMN booking_monthly_deposit numeric(10,2);
