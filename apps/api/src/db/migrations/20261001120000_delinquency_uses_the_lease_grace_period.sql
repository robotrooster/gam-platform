-- S654 (Nic): "flag a difference between outstanding and delinquent based on
-- when the grace period ends."
--
-- units.status = 'delinquent' was set by a fixed five days past due (S638).
-- Every lease carries its own grace period (lease, else property, else 5), and
-- the late-fee engine already reads it that way; the unit's status now follows
-- the same clock. Nothing else changes: still a real cash rent charge, still
-- open, not suspended by work trade, not covered by an account credit.
--
-- No backfill needed: the trigger re-evaluates a unit on its next payment-row
-- change, and the dashboard reads open rows live (routes/landlords.ts).
CREATE OR REPLACE FUNCTION sync_unit_delinquency() RETURNS trigger AS $$
DECLARE
  target_unit uuid := COALESCE(NEW.unit_id, OLD.unit_id);
  owed        numeric;
  credit      numeric;
BEGIN
  IF target_unit IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;
  SELECT COALESCE(SUM(p.amount), 0) INTO owed
    FROM payments p
    JOIN units u ON u.id = p.unit_id
    JOIN properties pr ON pr.id = u.property_id
    LEFT JOIN leases l ON l.id = p.lease_id
   WHERE p.unit_id = target_unit
     AND p.type = 'rent'
     AND p.status IN ('pending', 'failed')
     AND p.work_trade_suspended_at IS NULL
     AND (NOW() AT TIME ZONE COALESCE(pr.timezone, 'America/Phoenix'))::date
           > p.due_date + COALESCE(l.late_fee_grace_days, pr.late_fee_grace_days, 5);
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
