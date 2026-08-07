-- Rename maintenance_requests.contractor_id -> assigned_to.
--
-- WHY: the column holds whoever the landlord ROUTES a tenant's maintenance
-- request to — either an in-house PAYROLL worker (role 'maintenance', scoped
-- via maintenance_worker_scopes) OR, for a bigger job, an outside CONTRACTOR
-- (future blind-bid bulletin board — landlord posts the job, contractors bid,
-- bids sealed from each other to keep pricing honest; winner gives up 5% for
-- GAM coordinating). The old name "contractor_id" is a leftover from the
-- abandoned `contractors` marketplace and misdescribes the in-house-worker
-- case, which is the common one today. "assigned_to" reflects the real
-- meaning: the user this job is assigned to, whoever they are.
--
-- SAFE: pure rename, no data change. The FK (-> users(id) ON DELETE SET NULL)
-- is preserved; its constraint is renamed to match. The camelized wire format
-- changes contractor_id -> assignedTo; the frontend reads are updated in the
-- same pass. No backfill needed.

ALTER TABLE public.maintenance_requests
  RENAME COLUMN contractor_id TO assigned_to;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'maintenance_requests_contractor_id_fkey'
  ) THEN
    ALTER TABLE public.maintenance_requests
      RENAME CONSTRAINT maintenance_requests_contractor_id_fkey
      TO maintenance_requests_assigned_to_fkey;
  END IF;
END $$;
