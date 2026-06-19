-- Add the 'turnover' inspection type — the landlord's clean/repair of an
-- empty unit between tenancies. This makes the turn a first-class inspection
-- stage so the in-house unit video lifecycle (move-in -> move-out -> turnover
-- -> next move-in) has a record for it, and so the standard photo checklist
-- gets seeded for turn inspections too.
--
-- Fix-forward: drop and re-add the CHECK with the expanded set. Single source
-- of the allowed values is INSPECTION_TYPES in packages/shared.
-- No backfill needed — all existing rows are in the prior allowed set.
ALTER TABLE unit_inspections DROP CONSTRAINT unit_inspections_inspection_type_check;
ALTER TABLE unit_inspections ADD CONSTRAINT unit_inspections_inspection_type_check
  CHECK (inspection_type = ANY (ARRAY['move_in'::text, 'move_out'::text, 'periodic'::text, 'turnover'::text]));
