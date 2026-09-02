-- S631 (Nic, DIRECTIVE): "Let's flag on invite so that no matter when they
-- accept it, the work-trade agreement has inserted it slightly before the
-- invoice is created. It needs to be flagged as work trade BEFORE the invoice is
-- generated. That way it's automatically in a suspended state."
--
-- The ordering problem this removes: a work-trade agreement requires an ACTIVE
-- LEASE, and the lease is the thing the tenant is still signing. So the landlord
-- could not mark anyone work-trade until after signing — by which point the
-- first invoice already existed and was chargeable. S631 patched that after the
-- fact (starting an agreement exempts open invoices); this removes the race
-- instead of catching it, by recording the intent at INVITE time, when the
-- landlord actually knows.
--
-- The hours target is captured here too. It is the number the landlord agreed
-- with that resident, and asking again after signing is how it ends up as the
-- property default for somebody who negotiated something else.
ALTER TABLE pending_tenant_intents
  ADD COLUMN IF NOT EXISTS is_work_trade boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS work_trade_hours_target integer,
  ADD COLUMN IF NOT EXISTS work_trade_duties text;

COMMENT ON COLUMN pending_tenant_intents.is_work_trade IS
  'S631: this resident trades work for rent. A work_trade_agreement is created from this the moment their lease exists, BEFORE the move-in invoice, so the first invoice is late-fee exempt from birth.';

ALTER TABLE pending_tenant_intents
  DROP CONSTRAINT IF EXISTS pti_work_trade_hours_positive;
ALTER TABLE pending_tenant_intents
  ADD CONSTRAINT pti_work_trade_hours_positive
  CHECK (work_trade_hours_target IS NULL OR work_trade_hours_target > 0);
