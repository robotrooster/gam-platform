-- 10/12 (Nic) — GAM BOOKS, PHASE P7: EXTRA WORK-TRADE HOURS CAN BE PAID IN GAM BOOKS
--
-- Nic, 10/12: paid extra work-trade hours are wages the landlord pays a person,
-- "Both" ways — by hand (Mark paid on the Work Trade page: check or cash), or
-- by pressing Send to GAM Books, where they become a paycheck line on a
-- payroll run (W-2) or a contractor payment on the Expenses record (1099).
--
-- Approving the payroll run that carries a W-2 record marks it paid
-- (routes/books.ts POST /payroll/runs/:id/approve), and paying the contractor
-- expense a 1099 record became marks it paid too — both with
-- paid_how = 'gam_books'. The CHECK from migration 20261012180200 allowed only
-- the two by-hand ways, so approving any run that paid extra hours was refused
-- by the database. This widens it to WORK_TRADE_EXTRA_PAID_HOW_RECORDED
-- (packages/shared index.ts): 'check', 'cash', 'gam_books'. Mark paid still
-- offers only check and cash (WORK_TRADE_EXTRA_PAID_HOW).
--
-- Idempotent (drop if present, then add the same shape), so it lands the same
-- whichever order it runs in beside any other phase that widens it.
-- Expand-only: every existing value still passes; safe before the code ships.
-- No backfill needed (nothing has been paid in GAM Books yet).
-- Safe drop: re-add the CHECK with ('check', 'cash') once no row says 'gam_books'.

SET LOCAL lock_timeout = '10s';

ALTER TABLE work_trade_extra_hours DROP CONSTRAINT IF EXISTS work_trade_extra_hours_paid_how_check;
ALTER TABLE work_trade_extra_hours
  ADD CONSTRAINT work_trade_extra_hours_paid_how_check
  CHECK (paid_how IS NULL OR paid_how IN ('check', 'cash', 'gam_books'));
