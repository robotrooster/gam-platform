-- S552 (Nic): landlord-side screening billing accruals.
--
-- The money model (locked): the applicant pays the standard all-in screening
-- total (package cost + card processing) where state law allows; in capped /
-- actual-cost / prohibited states they pay less (or nothing). The LANDLORD
-- pays, per screening ordered under their account:
--   compliance_fee — flat $5 for GAM's screening administration + customer
--                    vetting (Credit Bureau end-user obligations Checkr
--                    pushes down to the platform)
--   shortfall      — standard all-in total MINUS what the applicant could
--                    legally be charged (0 in uncapped states). Computed on
--                    the ALL-IN basis so GAM nets exactly zero on processing
--                    (never eats fees, never silently margins on caps).
--
-- One row per background check, written at submit time (facts recorded when
-- the cost is incurred). Collection rides the monthly platform-fee invoice:
-- rows are swept by accrual_month alongside platform_fee_accruals. billed_at
-- stamps the sweep — NULL = not yet collected.
--
-- No backfill needed: applies to checks submitted from now on.

CREATE TABLE screening_fee_accruals (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  background_check_id uuid NOT NULL UNIQUE REFERENCES background_checks(id),
  landlord_id         uuid NOT NULL REFERENCES landlords(id),
  accrual_month       date NOT NULL,             -- first of the submit month
  compliance_fee      numeric(10,2) NOT NULL,
  standard_total      numeric(10,2) NOT NULL,    -- all-in applicant total, uncapped basis
  applicant_charged   numeric(10,2) NOT NULL,    -- what the applicant actually paid
  shortfall           numeric(10,2) NOT NULL,    -- standard_total - applicant_charged
  state               char(2),                   -- property state the cap resolved from
  billed_at           timestamptz,               -- NULL until swept into an invoice
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_screening_fee_accruals_landlord_month
  ON screening_fee_accruals (landlord_id, accrual_month);
