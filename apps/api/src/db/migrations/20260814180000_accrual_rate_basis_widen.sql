-- S604 fix-forward: the accrual-row rate_basis CHECK was created before the
-- full 50-state read discovered actual_earned / actual_minus_admin /
-- index_linked / none. Stamping any of those violated the constraint, the
-- INSERT threw, and the deposit was counted as an ERROR with no accrual row —
-- i.e. states like ND, NH, NY and PA would silently fail to accrue at all.
--
-- Caught by the engine tests, which is why they assert on totals rather than
-- just on the absence of an exception.
--
-- Kept in sync with sdir_rate_basis_check on state_deposit_interest_rates.

ALTER TABLE security_deposit_interest_accruals
  DROP CONSTRAINT IF EXISTS sdi_accruals_rate_basis_check;
ALTER TABLE security_deposit_interest_accruals
  ADD CONSTRAINT sdi_accruals_rate_basis_check
  CHECK (rate_basis IS NULL OR rate_basis IN (
    'fixed','lesser_of_actual','share_of_actual',
    'actual_earned','actual_minus_admin','index_linked','none'));
