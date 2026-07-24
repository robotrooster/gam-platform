-- S550: link a move-out inspection checklist item to the conditional
-- lease_fee it assesses. insertInspectionWithChecklist appends one item per
-- unassessed conditional fee (area 'Lease conditions'); at finalize the
-- item's condition writes back to lease_fees.condition_result via this FK —
-- no fragile label matching. NULL for every ordinary checklist item.
-- No backfill needed.

ALTER TABLE unit_inspection_items
  ADD COLUMN lease_fee_id uuid REFERENCES lease_fees(id);
