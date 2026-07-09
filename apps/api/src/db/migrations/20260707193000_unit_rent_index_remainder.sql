-- Same remainder carve-out for the UNIT-level rent uniqueness index
-- (S533; companion to 20260707190000 which fixed the lease-level one).
-- ux_payments_unit_rent_due_date_active guarantees one active rent row
-- per (unit, due_date); propane-redistribution remainder rows are the
-- legitimate second row for the cycle and are excluded — generation
-- paths never set is_remainder, so the original guarantee holds.
--
-- No backfill needed.

DROP INDEX ux_payments_unit_rent_due_date_active;
CREATE UNIQUE INDEX ux_payments_unit_rent_due_date_active
    ON payments (unit_id, due_date)
    WHERE type = 'rent'
      AND status <> ALL (ARRAY['failed'::text, 'returned'::text])
      AND NOT is_remainder;
