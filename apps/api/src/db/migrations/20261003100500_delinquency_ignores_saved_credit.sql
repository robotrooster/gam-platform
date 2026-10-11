-- S655 money plan M6 (Step 1). Replaces a trigger function with the same
-- signature; the trigger itself (trg_sync_unit_delinquency) is unchanged.
--
-- Nic (10/2): saved credit does not stop a late bill. Until now the unit's
-- delinquency subtracted every active tenant credit from the late rent, so a
-- $10 credit hid part of a $460 late rent and a credit as large as the rent hid
-- the whole of it without paying anything. A credit that covers the WHOLE bill
-- is applied to it (creditUse.settleWholeBillIfCovered), which settles the rows
-- and lands back here with nothing owed. A smaller saved credit changes nothing.
--
-- Takes effect the moment it is applied: a unit whose late rent was masked by
-- saved credit turns delinquent (the deploy's P10 check counts them).
CREATE OR REPLACE FUNCTION public.sync_unit_delinquency() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_unit uuid := COALESCE(NEW.unit_id, OLD.unit_id);
  owed        numeric;
BEGIN
  IF target_unit IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;
  -- S655 (Nic): saved credit does not stop a late bill. A credit that covers the
  -- whole bill is applied to it (creditUse.settleWholeBillIfCovered), which
  -- settles the rows and lands back here with nothing owed.
  SELECT COALESCE(SUM(p.amount), 0) INTO owed
    FROM payments p
    JOIN units u ON u.id = p.unit_id
    JOIN properties pr ON pr.id = u.property_id
    LEFT JOIN leases l ON l.id = p.lease_id
   WHERE p.unit_id = target_unit
     AND p.type = 'rent'
     AND p.status IN ('pending','failed')
     AND p.work_trade_suspended_at IS NULL
     AND (NOW() AT TIME ZONE COALESCE(pr.timezone, 'America/Phoenix'))::date
           > p.due_date + COALESCE(l.late_fee_grace_days, pr.late_fee_grace_days, 5);
  IF owed > 0 THEN
    UPDATE units SET status = 'delinquent', updated_at = NOW()
     WHERE id = target_unit AND status = 'active';
  ELSE
    UPDATE units SET status = 'active', updated_at = NOW()
     WHERE id = target_unit AND status = 'delinquent';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
