-- S550 fix-forward: the lease_fee link on inspection items must not block
-- lease_fees deletion (or the test-schema cleanup order). If the fee row
-- goes away, the checklist item stays as a historical walkthrough line with
-- the clause text in its notes — the link just nulls out.

ALTER TABLE unit_inspection_items
  DROP CONSTRAINT unit_inspection_items_lease_fee_id_fkey,
  ADD CONSTRAINT unit_inspection_items_lease_fee_id_fkey
    FOREIGN KEY (lease_fee_id) REFERENCES lease_fees(id) ON DELETE SET NULL;
