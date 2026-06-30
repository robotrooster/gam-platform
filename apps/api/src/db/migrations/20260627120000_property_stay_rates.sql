-- S518 / Master Schedule pricing: property-level stay rates + short-term tax.
--
-- WHY (Nic 2026-06-27): a reservation's price is pulled from the PROPERTY's
-- nightly/weekly/monthly rates (one rate set per property, applied to its
-- units), prorated for odd lengths (e.g. 32 nights = monthly + 2/30·monthly).
-- Short-term stays (< 30 nights) add a landlord-set lodging tax; stays of 30+
-- nights are tax-exempt. National platform → the tax rate is landlord-
-- configurable per property, not a hardcoded jurisdiction rate.
--
-- No backfill: all default NULL/0; pricing falls back gracefully when unset.

ALTER TABLE properties
  ADD COLUMN nightly_rate        numeric(10,2),
  ADD COLUMN weekly_rate         numeric(10,2),
  ADD COLUMN monthly_rate        numeric(10,2),
  ADD COLUMN short_term_tax_rate numeric(5,2) NOT NULL DEFAULT 0,
  ADD CONSTRAINT properties_short_term_tax_rate_range
    CHECK (short_term_tax_rate >= 0 AND short_term_tax_rate <= 100);
