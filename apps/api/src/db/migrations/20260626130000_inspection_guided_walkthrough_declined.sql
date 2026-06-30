-- Remote/guided inspection: "ask once, never re-prompt if declined" (POS-walkthrough #23, 2026-06-26)
--
-- WHY: the agent can guide a tenant through a self-recorded ("remote") move-in/
-- move-out inspection. Tenants who decline that offer were getting re-asked on
-- later visits. This flag lets the agent see a prior decline (across sessions)
-- and stop offering — it only guides if the tenant brings it up again.
--
-- NO BACKFILL NEEDED — new boolean defaults false (nobody has declined yet).
ALTER TABLE public.unit_inspections
  ADD COLUMN IF NOT EXISTS guided_walkthrough_declined boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS guided_walkthrough_declined_at timestamp with time zone;
