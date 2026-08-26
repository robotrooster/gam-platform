-- S624 — the evidence for a confirmed payment must not be deletable.
--
-- The original FK was ON DELETE SET NULL, which contradicted this table's own
-- check constraint: a `confirmed` declaration must name the bank transaction
-- that confirmed it. Deleting the transaction would blank the column and leave
-- the row violating its own rule — so the delete failed with a confusing
-- constraint error rather than an honest one, and a confirmed rent payment
-- ended up with its proof half-detached.
--
-- RESTRICT is the correct relationship and it states the real rule: you cannot
-- throw away the bank row that proves a tenant's rent was paid. Production never
-- deletes bank transactions (they are synced, never removed — nothing in the
-- codebase issues a DELETE against them), so this constrains only test teardown,
-- which now clears declarations first. That ordering is not an inconvenience; it
-- is the dependency being told truthfully.

ALTER TABLE tenant_declared_deposits
  DROP CONSTRAINT IF EXISTS tenant_declared_deposits_bank_transaction_id_fkey;
ALTER TABLE tenant_declared_deposits
  ADD CONSTRAINT tenant_declared_deposits_bank_transaction_id_fkey
  FOREIGN KEY (bank_transaction_id) REFERENCES bank_transactions(id) ON DELETE RESTRICT;
