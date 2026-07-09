-- Backfill reading_start / reading_end on historical utility bills (S534).
--
-- Migration 220000 added the begin/end read snapshots for tenant-invoice
-- transparency, but only bills created after it carry them. The landlord
-- bills table now shows the reads too (Nic), so derive the missing
-- snapshots for older SUBMETER bills from the readings history:
--   reading_end   = the meter's reading for the bill's cycle
--   reading_start = the closest prior-cycle reading
-- Best-effort by design — a bill whose readings were later corrected may
-- not reconcile exactly with its charge; the charge is the record, the
-- reads are informational. RUBS bills have no per-unit reads (untouched).
--
-- No schema change; data-only backfill. Safe to re-run (targets NULLs).
-- (Correlated subqueries, not LATERAL — Postgres forbids FROM-clause
-- references to the UPDATE target.)

UPDATE utility_bills ub
   SET reading_end = (
         SELECT r.reading_value FROM utility_meter_readings r
          WHERE r.meter_id = ub.meter_id
            AND r.billing_cycle_month = ub.billing_cycle_month
          ORDER BY r.reading_date DESC LIMIT 1),
       reading_start = (
         SELECT r.reading_value FROM utility_meter_readings r
          WHERE r.meter_id = ub.meter_id
            AND r.billing_cycle_month < ub.billing_cycle_month
          ORDER BY r.billing_cycle_month DESC, r.reading_date DESC LIMIT 1)
 WHERE ub.reading_start IS NULL
   AND ub.reading_end IS NULL
   AND EXISTS (SELECT 1 FROM utility_meters m
                WHERE m.id = ub.meter_id AND m.billing_method = 'submeter')
   AND EXISTS (SELECT 1 FROM utility_meter_readings r
                WHERE r.meter_id = ub.meter_id
                  AND r.billing_cycle_month = ub.billing_cycle_month)
   AND EXISTS (SELECT 1 FROM utility_meter_readings r
                WHERE r.meter_id = ub.meter_id
                  AND r.billing_cycle_month < ub.billing_cycle_month);
