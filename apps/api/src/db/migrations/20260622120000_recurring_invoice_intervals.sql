-- S511 — extend recurring-invoice billing intervals.
--
-- WHY: business owners bill some customers on cadences longer than monthly
-- (quarterly maintenance contracts, semiannual service plans, annual retainers).
-- The S505 schedule table only allowed 'weekly' / 'monthly'. We add three
-- month-stepped frequencies. All non-weekly frequencies are "monthly-like":
-- they anchor to a day_of_month and differ only in how many months the cadence
-- advances per cycle (handled in app code via RECURRING_INVOICE_MONTH_STEP).
--
-- No backfill needed — existing rows are all 'weekly'/'monthly' and remain valid
-- under the widened constraints. Fix-forward; do not edit the S505 migration.

ALTER TABLE public.business_recurring_invoice_schedules
  DROP CONSTRAINT business_recurring_invoice_schedules_frequency_check;

ALTER TABLE public.business_recurring_invoice_schedules
  ADD CONSTRAINT business_recurring_invoice_schedules_frequency_check
  CHECK (frequency = ANY (ARRAY[
    'weekly'::text, 'monthly'::text, 'quarterly'::text,
    'semiannual'::text, 'annual'::text
  ]));

-- Cadence shape: weekly anchors to day_of_week; every other (month-based)
-- frequency anchors to day_of_month. day_of_month range (1..28) is enforced by
-- the existing _dom_range constraint and is unchanged here.
ALTER TABLE public.business_recurring_invoice_schedules
  DROP CONSTRAINT business_recurring_invoice_schedules_cadence_check;

ALTER TABLE public.business_recurring_invoice_schedules
  ADD CONSTRAINT business_recurring_invoice_schedules_cadence_check
  CHECK (
    (
      frequency = ANY (ARRAY['monthly'::text, 'quarterly'::text, 'semiannual'::text, 'annual'::text])
      AND day_of_month IS NOT NULL AND day_of_week IS NULL
    )
    OR
    (
      frequency = 'weekly'::text
      AND day_of_week IS NOT NULL AND day_of_month IS NULL
    )
  );
