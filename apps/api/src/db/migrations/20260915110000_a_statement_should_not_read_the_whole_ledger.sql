-- S644 — the index the owner statement stands on.
--
-- user_balance_ledger grows by one row per settled payment per split, forever.
-- Today that is 17 rows. A manager with 11,000 units writes roughly that many
-- allocation rows EVERY MONTH, so within a year the table holds a few hundred
-- thousand and an owner statement is asking it for one month of a handful of
-- properties out of all of them.
--
-- The existing index is on property_id alone, so a statement would find every
-- allocation that property has ever had and then throw away all but one month.
-- That is survivable at 120 units and quietly terrible at 11,000: the cost grows
-- with how long the owner has been a customer, which is exactly backwards.
--
-- Partial on the two allocation types because that is what a statement reads and
-- it keeps the index small — the ledger also carries withdrawals, credits and
-- transfer records that no statement ever asks for.
CREATE INDEX IF NOT EXISTS idx_user_balance_ledger_statement
  ON user_balance_ledger (property_id, created_at)
  WHERE type IN ('allocation_owner_share', 'allocation_pm_company_fee');
