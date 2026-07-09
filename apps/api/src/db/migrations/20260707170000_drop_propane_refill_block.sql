-- Drop the propane refill block (Nic, S533 correction — same session).
--
-- The "don't refill until the previous fill is paid" gate assumed the
-- refill company coordinates with the office. They don't — the truck
-- just fills tanks. Blocking the fill RECORD doesn't stop the fill,
-- it just loses the billing. Replaced by ACCELERATION as standard
-- behavior: recording a new fill while prior installments remain makes
-- the entire prior balance due immediately (each remaining installment
-- becomes a standalone due-now payment) alongside the new fill's first
-- payment.
--
-- Safe drop: the toggle shipped earlier TODAY, default false, no
-- production data; the fills/installments tables are untouched.

ALTER TABLE properties DROP COLUMN propane_block_refill_until_paid;
