-- units.is_ada_accessible (S573, Nic) — inspection-template filter input.
--
-- WHY: an accessible unit carries accommodation features (grab bars, roll-in
-- shower, ramps, door clearances, accessible parking/path) that a standard
-- unit doesn't — and that the landlord is obligated to keep functional. When
-- flagged, the inspection master template (buildInspectionChecklist) layers an
-- Accessibility area onto the normal checklist. Same filter-input shape/role as
-- is_multi_level and bed/bath counts.
--
-- SCOPE: the checklist items are GENERIC FEDERAL accommodation checks only. Per
-- GAM's standing no-state-specific-legal-logic rule, per-state accessibility
-- inspection variances are NOT encoded here — that would be a conscious,
-- counsel-backed decision, not a default.
--
-- NO BACKFILL NEEDED: defaults false. A landlord marks a unit accessible in
-- unit setup; the pre-inspection review surfaces the resolved checklist so a
-- mis-set unit is caught before the inspection runs.
ALTER TABLE units
  ADD COLUMN IF NOT EXISTS is_ada_accessible boolean NOT NULL DEFAULT false;
