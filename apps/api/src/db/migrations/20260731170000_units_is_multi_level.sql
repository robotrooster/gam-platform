-- units.is_multi_level (S573, Nic) — inspection-template filter input.
--
-- WHY: the inspection master template (buildInspectionChecklist) tailors the
-- checklist off the unit's real attributes (unit_type, bedrooms, bathrooms,
-- dwelling_ownership). Stairs/handrails only exist on a multi-level dwelling,
-- so without this flag the template can't decide whether to ask for a photo of
-- the staircase & handrail. This is a pure filter input — same shape/role as
-- bedrooms and bathrooms — set at unit setup, not an inspection concept.
--
-- NO BACKFILL NEEDED: defaults to false (single-level). A landlord marks a
-- unit multi-level in unit setup; the pre-inspection review surfaces the
-- resolved checklist so a mis-set unit is caught and corrected before the
-- inspection runs.
ALTER TABLE units
  ADD COLUMN IF NOT EXISTS is_multi_level boolean NOT NULL DEFAULT false;
