-- S615 CORRECTION to 20260821210000, caught before it ever ran outside dev.
--
-- That migration rewrote ux_invoices_lease_due_date as a PARTIAL index
-- (WHERE lease_id IS NOT NULL) on the reasoning that a nullable column needs
-- its uniqueness restated per payer source. It does not, and the change was
-- actively dangerous:
--
-- Postgres can only infer a PARTIAL index for ON CONFLICT when the statement
-- repeats the index predicate. Four live statements say plain
-- `ON CONFLICT (lease_id, due_date) DO NOTHING` — invoiceGeneration (x2),
-- moveInBundle, and the landlord backfill route. Against a partial index every
-- one of them raises 42P10 "no unique or exclusion constraint matching the ON
-- CONFLICT specification". That is not a degraded edge case: it is EVERY rent
-- invoice for EVERY tenant on the platform failing to generate, to fix a
-- lease-less utility bill for the three spaces next door.
--
-- The full index was always correct here. A unique index treats NULLs as
-- DISTINCT, so rows with lease_id IS NULL never collide with each other or
-- with anything else under it — service invoices simply do not participate,
-- which is exactly what ux_invoices_service_agreement_due_date is for.
--
-- Restored byte-for-byte to its pre-S615 definition.
DROP INDEX IF EXISTS ux_invoices_lease_due_date;
CREATE UNIQUE INDEX ux_invoices_lease_due_date
  ON invoices (lease_id, due_date);
