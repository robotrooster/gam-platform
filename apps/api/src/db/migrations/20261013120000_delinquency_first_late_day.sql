-- 10/12 (Nic) — a space turns delinquent on the same FIRST LATE DAY as everything else.
--
--   "First LATE day = due/lateness-start + grace days (rent due the 1st, 5-day
--    grace → the 6th is late, the day late fees start)."
--   "Grace = lease, else property, else 5 — the only chain."
--   LF1 (zero grace): "NEXT DAY is late (paying on the due date is on time)."
--   LF2 (a bill written after its due date): late counts "from the DAY IT WAS
--    WRITTEN (grace starts then)" — "delinquency trigger too".
--
-- services/lateness.ts is the one lateness rule: lateness starts on the due
-- date, or on the day GAM wrote the bill when that is later (lateCountsFromSql,
-- writtenAtSql); the first late day is that start plus GREATEST(grace, 1)
-- (firstLateDaySql); a day is past grace when it is ON OR AFTER the first late
-- day (pastGraceSql). The morning delinquency job (jobs/scheduler.ts, 7am
-- Phoenix), Outstanding, the Payments ledger, the Rent Roll, the digest and
-- the credit history all read it.
--
-- This trigger (trg_sync_unit_delinquency on payments, which re-judges a space
-- every time one of its charges changes) read "AFTER due + grace", counted from
-- the due date: the 7th for rent due the 1st with 5 days. So on the 6th the
-- morning job marked a space delinquent and the next change to any of its
-- charges that day cleared it again. With a grace of 0 both already picked the
-- day after the due date; the change moves the day only for a grace of 1 or
-- more. And a bill GAM wrote after its due date (an onboarding bill for the 1st
-- written on the 10th) turned the space delinquent the moment it was inserted,
-- while the Rent Roll beside it read "Due · not late yet". Now the trigger asks
-- the same question as the one rule:
--   today >= GREATEST(due date, the day GAM wrote the bill) + GREATEST(grace, 1)
-- on the property's calendar.
--
-- The day GAM wrote the bill mirrors lateness.writtenAtSql: the row's own
-- created_at; a row that carries over an older bill — a row a reversal reopened
-- (reversal_id), or the rest of a row paid in part (is_remainder with the
-- rest-of-bill notes) — takes the earliest created_at of the same bill (same
-- lease, person, kind, due date and invoice); a line work trade held counts
-- from the moment it was released (the journaled change that cleared
-- work_trade_suspended_at — audit_payments runs before this trigger, both
-- AFTER triggers fire in name order). Only unpaid rows are summed, so the day
-- they are paid is today and the written day is always on or before it; the
-- later of the two days is the lateness start.
--
-- A $0 rent line is never owed (10/12: $0 lines are ignored) — it already
-- added nothing to the sum; it is now left out by name. Everything else is
-- unchanged from 20260909120000 / 20261003100500_delinquency_ignores_saved_credit
-- .sql: rent only, pending or failed, not held by work trade, saved credit does
-- not stop a late bill.
--
-- Expand-only: a CREATE OR REPLACE of a trigger function with the same
-- signature; the trigger itself is untouched. Safe to apply before the code
-- ships: it only changes which day a space's status flips. The deployed
-- morning job marks on the 6th for a 5-day grace counted from the due date, so
-- until the code ships a space whose only late bill was written after its due
-- date can be marked by that job in the morning and cleared here on the next
-- change to its charges; the job that ships with this counts from the same
-- later day (jobs/scheduler.ts), and the two agree again.
--
-- No backfill needed: the function takes effect on the next change to a
-- space's charges, and the 7am job re-reads every space each morning.
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
  -- 10/12 (Nic): late from the first late day — the later of the due date and
  -- the day GAM wrote the bill, + GREATEST(grace, 1), the day late fees start
  -- (services/lateness lateCountsFromSql / writtenAtSql / pastGraceSql).
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
                    + GREATEST(COALESCE(l.late_fee_grace_days, pr.late_fee_grace_days, 5), 1);
  IF owed > 0 THEN
    UPDATE units SET status = 'delinquent', updated_at = NOW()
     WHERE id = target_unit AND status = 'active';
  ELSE
    UPDATE units SET status = 'active', updated_at = NOW()
     WHERE id = target_unit AND status = 'delinquent';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
