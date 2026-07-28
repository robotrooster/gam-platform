-- S558 (Nic): default lease TERM as a per-unit-type setting, carried on the
-- template (the template is the per-unit-type artifact). The landlord's
-- "primary apartment lease" states a 12-month term; the "primary storage lease"
-- / "primary RV lease" are month-to-month. When a lease auto-drafts off a unit,
-- the term dates prefill from the unit's default template so the landlord never
-- retypes them — set the template up right and the draft does the work.
--
-- default_term_months: NULL = month-to-month (no end date); N (1..120) = fixed
-- N-month term (end_date = start_date + N months). No backfill (pre-launch;
-- existing templates default to NULL = month-to-month, the safe non-committal
-- term — a landlord picks the real term when they configure the template).
ALTER TABLE public.lease_templates
  ADD COLUMN default_term_months integer
  CONSTRAINT lease_templates_default_term_months_check
  CHECK (default_term_months IS NULL OR (default_term_months >= 1 AND default_term_months <= 120));
