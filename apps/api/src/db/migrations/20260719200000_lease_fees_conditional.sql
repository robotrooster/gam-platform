-- S550 (Nic): CONDITIONAL lease fees — "if you don't do X (or do X), then
-- $Y". The canonical case: "professional carpet cleaning required within N
-- days of move-out, else $150". Document-first / lease-is-law: these rows
-- exist ONLY when the clause prints in the signed lease (parser-extracted or
-- landlord-entered at import review).
--
-- condition_text  = the clause from the lease (why this fee can exist).
-- condition_result= NULL until a human assesses it; 'met' (no charge) or
--                   'failed' (charge). Assessed on the move-out inspection —
--                   each unassessed conditional fee becomes a checklist item
--                   in the 'Lease conditions' area; good/fair -> met,
--                   damaged/missing -> failed.
-- The S180 deposit sweep MUST NOT auto-sum a conditional fee unless its
-- condition_result = 'failed' (services/depositReturn.ts).
-- No backfill needed: all existing rows are unconditional (condition_text
-- NULL) and keep today's behavior exactly.

ALTER TABLE lease_fees
  ADD COLUMN condition_text text,
  ADD COLUMN condition_result text
    CHECK (condition_result IS NULL OR condition_result IN ('met', 'failed')),
  ADD COLUMN condition_assessed_at timestamptz,
  ADD COLUMN condition_assessed_by uuid REFERENCES users(id);
