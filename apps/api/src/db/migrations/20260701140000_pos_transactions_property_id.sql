-- pos_transactions.property_id — tie every POS sale to the property it happened at.
--
-- Why: front-counter staff (the new modular "cashier" access) are hard-locked to
-- their assigned property, so the register enforces a property on every sale.
-- Until now only FlexCharge sales carried a property (transitively via
-- flex_charge_accounts); plain cash/card sales stored no property at all, which
-- is wrong for multi-property operators (RV parks) and blocks per-property
-- reporting and the cashier property-lock.
--
-- Nullable + no backfill: historical rows predate the column and legitimately
-- have no property attribution (owners could ring without selecting one). New
-- sales from a scoped worker always carry it (enforced in routes/pos.ts via
-- assertPropertyInScope); owner sales carry it when a property is selected.
ALTER TABLE pos_transactions
  ADD COLUMN property_id uuid REFERENCES properties(id) ON DELETE SET NULL;

CREATE INDEX idx_pos_transactions_property ON pos_transactions (property_id);
