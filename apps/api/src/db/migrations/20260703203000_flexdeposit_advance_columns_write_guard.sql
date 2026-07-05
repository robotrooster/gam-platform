-- S527: hard write-guards on the RETIRED advance-model columns of
-- security_deposits. FlexDeposit is a CUSTODY service (S512/S514): GAM
-- advances nothing, and there is no acceleration, so these columns must
-- never hold a value again. They stay in place for historical shape, but a
-- CHECK now blocks any accidental write from future deposit code — writing
-- them would silently reintroduce advance-model ledger semantics.
--
-- No backfill needed: verified zero rows violate (dev table empty; the
-- columns were flagged DEPRECATED-never-written at the S514 rework).
ALTER TABLE security_deposits
  ADD CONSTRAINT security_deposits_no_advance_chk
    CHECK (gam_advance_amount IS NULL OR gam_advance_amount = 0),
  ADD CONSTRAINT security_deposits_no_acceleration_chk
    CHECK (balance_due_full_at IS NULL AND balance_due_total IS NULL);
