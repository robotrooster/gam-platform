-- S638 (Nic): "The current unit overview list shows several people being
-- delinquent that are not delinquent... this page is not currently synced up in
-- real time to outstanding balances. It also has the work trade people as
-- delinquent."
--
-- One line in the 7am job set units.status='delinquent' and NOTHING anywhere
-- set it back, so a unit marked once stayed marked however much the resident
-- paid. Thirteen units were flagged; four were work-trade households who owe
-- nothing and never did, three more had already cleared their balance.
--
-- A trigger rather than a call at each settle point: rent is settled from the
-- desk (manual cash/check), the Stripe webhook (card/ACH), the bank-deposit
-- match and the work-trade month close. A rule that has to be remembered in
-- four places is a rule that will be missed in a fifth — the same reasoning as
-- the unit retire/replace guards.
--
-- Delinquent means: a real cash rent charge, past due, still open, not
-- suspended by work trade, and not covered by an account credit. Anything else
-- is 'active'.
CREATE OR REPLACE FUNCTION sync_unit_delinquency() RETURNS trigger AS $$
DECLARE
  target_unit uuid := COALESCE(NEW.unit_id, OLD.unit_id);
  owed        numeric;
  credit      numeric;
BEGIN
  IF target_unit IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;

  SELECT COALESCE(SUM(p.amount), 0) INTO owed
    FROM payments p
   WHERE p.unit_id = target_unit
     AND p.type = 'rent'
     AND p.status IN ('pending', 'failed')
     AND p.work_trade_suspended_at IS NULL
     AND p.due_date <= NOW() - INTERVAL '5 days';

  SELECT COALESCE(SUM(c.amount_remaining), 0) INTO credit
    FROM tenant_credits c
    JOIN lease_tenants lt ON lt.tenant_id = c.tenant_id AND lt.status = 'active'
    JOIN leases l ON l.id = lt.lease_id AND l.unit_id = target_unit AND l.status = 'active'
   WHERE c.status = 'active' AND c.amount_remaining > 0;

  IF owed - credit > 0 THEN
    UPDATE units SET status = 'delinquent', updated_at = NOW()
     WHERE id = target_unit AND status = 'active';
  ELSE
    UPDATE units SET status = 'active', updated_at = NOW()
     WHERE id = target_unit AND status = 'delinquent';
  END IF;

  RETURN COALESCE(NEW, OLD);
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_unit_delinquency ON payments;
CREATE TRIGGER trg_sync_unit_delinquency
  AFTER INSERT OR UPDATE OF status, amount, due_date, work_trade_suspended_at
     OR DELETE
  ON payments
  FOR EACH ROW EXECUTE FUNCTION sync_unit_delinquency();
