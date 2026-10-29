-- 10/19 — THE DELINQUENCY TRIGGER STILL READ A COLUMN THAT IS BEING DROPPED.
--
-- 20261020130000_no_invented_late_fee_defaults_on_a_property.sql drops the
-- late-fee FIGURES off properties ("I never set $5 or $15 flat ... I don't know
-- how the $15 ever came to be"), having checked every TypeScript consumer. It
-- missed one consumer that is not TypeScript: the database's own
-- sync_unit_delinquency() trigger function, whose last line reads
--
--     + GREATEST(COALESCE(l.late_fee_grace_days, pr.late_fee_grace_days, 5), 1)
--
-- That function fires on payments (and keeps units.status between 'active' and
-- 'delinquent'), so with the column gone and the function unchanged, EVERY
-- write to a rent row at EVERY property fails:
--
--     error: column pr.late_fee_grace_days does not exist
--     where: PL/pgSQL function sync_unit_delinquency() line 13
--
-- Measured, not reasoned: a throwaway database loaded from schema.sql with the
-- tree's pending migrations applied in order could not insert a rent charge at
-- all, which took out all ten tests of the space-rent carry-forward suite and
-- would have taken out rent billing, the desk, and every payment path in
-- production the moment Nic ran `npm run migrate`.
--
-- NOTHING MOVES. The chain was lease -> property -> 5, and the property's value
-- is 5 at all seven properties (it was the schema default nobody chose, which
-- is the whole point of the migration that drops it). 82 of the 83 live leases
-- carry no grace of their own, so they were already resolving through the
-- property to 5 and now resolve to the same 5 directly; the one lease that sets
-- its own keeps it, as it always did. Checked read-only against production
-- before writing this.
--
-- Written as its own forward fix rather than an edit to 20261020130000, which
-- another session is holding, and sorted BEFORE the carry-forward feature's
-- migration so one `npm run migrate` run leaves the function and the columns
-- consistent.
--
-- No backfill: no data. Safe drop: there is nothing to drop — to undo, put the
-- `pr.late_fee_grace_days` term back, which requires the column back first.

SET LOCAL lock_timeout = '10s';

CREATE OR REPLACE FUNCTION sync_unit_delinquency()
RETURNS trigger AS $fn$
DECLARE
  target_unit uuid := COALESCE(NEW.unit_id, OLD.unit_id);
  owed        numeric;
BEGIN
  IF target_unit IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;
  -- S655 (Nic): saved credit does not stop a late bill. A credit that covers the
  -- whole bill is applied to it (creditUse.settleWholeBillIfCovered), which
  -- settles the rows and lands back here with nothing owed.
  -- 10/12 (Nic): late from the first late day — the later of the due date and
  -- the day GAM wrote the bill, + GREATEST(grace, 1), the day late fees start
  -- (services/lateness lateCountsFromSql / writtenAtSql / pastGraceSql).
  -- 10/19: the grace comes from the LEASE, where the real policy is stamped
  -- when the lease is drafted (property_unit_type_late_fees -> the lease), with
  -- the same 5 behind it the property column held for every property.
  SELECT COALESCE(SUM(p.amount), 0) INTO owed
    FROM payments p
    JOIN units u ON u.id = p.unit_id
    JOIN properties pr ON pr.id = u.property_id
    LEFT JOIN leases l ON l.id = p.lease_id
    CROSS JOIN LATERAL (
      SELECT (NOW() AT TIME ZONE COALESCE(pr.timezone, 'America/Phoenix'))::date AS today,
             ((CASE WHEN p.reversal_id IS NOT NULL
                      OR (p.is_remainder AND (p.notes LIKE 'What is left of the old balance after a part payment%'
                                           OR p.notes LIKE 'What is left of this bill after a part payment%'))
                    THEN (SELECT MIN(GREATEST(wf.created_at,
                                   (CASE WHEN wf.work_trade_suspended_at IS NULL
                                              AND (wf.notes LIKE '%suspended while the hours are worked%'
                                                OR wf.notes LIKE '%suspended until month close%'
                                                OR wf.notes LIKE '%No longer covered by the work trade%')
                                         THEN (SELECT MAX(wr.changed_at) FROM audit_row_changes wr
                                                WHERE wr.table_name = 'payments' AND wr.row_id = wf.id
                                                  AND wr.old_row->>'work_trade_suspended_at' IS NOT NULL
                                                  AND wr.new_row->>'work_trade_suspended_at' IS NULL) END)))
                            FROM payments wf
                           WHERE wf.lease_id IS NOT DISTINCT FROM p.lease_id
                             AND wf.tenant_id IS NOT DISTINCT FROM p.tenant_id
                             AND wf.type = p.type
                             AND wf.due_date = p.due_date
                             AND wf.invoice_id IS NOT DISTINCT FROM p.invoice_id
                             AND wf.created_at <= p.created_at)
                    ELSE GREATEST(p.created_at,
                           (CASE WHEN p.work_trade_suspended_at IS NULL
                                      AND (p.notes LIKE '%suspended while the hours are worked%'
                                        OR p.notes LIKE '%suspended until month close%'
                                        OR p.notes LIKE '%No longer covered by the work trade%')
                                 THEN (SELECT MAX(wr.changed_at) FROM audit_row_changes wr
                                        WHERE wr.table_name = 'payments' AND wr.row_id = p.id
                                          AND wr.old_row->>'work_trade_suspended_at' IS NOT NULL
                                          AND wr.new_row->>'work_trade_suspended_at' IS NULL) END))
               END) AT TIME ZONE COALESCE(pr.timezone, 'America/Phoenix'))::date AS written_day
    ) d
   WHERE p.unit_id = target_unit
     AND p.type = 'rent'
     AND p.status IN ('pending','failed')
     AND p.work_trade_suspended_at IS NULL
     AND p.amount > 0
     AND d.today >= GREATEST(p.due_date, COALESCE(d.written_day, p.due_date))
                    + GREATEST(COALESCE(l.late_fee_grace_days, 5), 1);
  IF owed > 0 THEN
    UPDATE units SET status = 'delinquent', updated_at = NOW()
     WHERE id = target_unit AND status = 'active';
  ELSE
    UPDATE units SET status = 'active', updated_at = NOW()
     WHERE id = target_unit AND status = 'delinquent';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $fn$ LANGUAGE plpgsql;
