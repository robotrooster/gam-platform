-- S91 / DEFERRED Item 3 (state-tax genericize): rename the AZ-prefixed
-- withholding column on books_employees to a generic state_withholding_pct.
--
-- Pre-S91 the column was hardcoded to AZ (default 2.5 = AZ flat rate).
-- That violated the GAM "no state-specific legal logic" rule that's been
-- on the books since S18 — the platform serves landlords nationwide, and
-- the column needs to accept whatever state-level rate the employer of
-- record actually uses.
--
-- Rename only — no value change for existing rows. Default drops from 2.5
-- to 0; landlords explicitly configure the rate per-employee. New
-- employees inherit 0 and the calcTaxes path treats 0 as "no state
-- withholding" (matches states with no income tax: TX, FL, NV, WA, etc).
--
-- Companion code changes (S91): books.ts:193 INSERT, books.ts:444
-- calcTaxes call site. The AZ A1-QRT / A1-R tax form rows in the filing
-- deadlines list (books.ts:1221-1222) get stripped — per-state tax form
-- catalog becomes landlord-configurable later, not a hardcoded AZ list.

ALTER TABLE books_employees RENAME COLUMN az_withholding_pct TO state_withholding_pct;
ALTER TABLE books_employees ALTER COLUMN state_withholding_pct SET DEFAULT 0;
