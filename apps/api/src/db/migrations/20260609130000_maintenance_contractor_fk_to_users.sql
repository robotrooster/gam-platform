-- Repoint maintenance_requests.contractor_id FK: contractors(id) -> users(id).
--
-- WHY: "assigning" a maintenance request means handing it to one of the
-- landlord's OWN maintenance-team workers (a users row, scoped through
-- maintenance_worker_scopes) — NOT a vendor from the platform-wide
-- `contractors` marketplace. Every consumer already treats contractor_id as
-- a worker: routes/maintenance.ts joins contractor_id -> users for the
-- "Assigned to" display, services/notifications.ts fans assignment notices
-- out to the maintenance team, and the S442 agent tools
-- (get_maintenance_team / assign_maintenance_request) resolve the assignee
-- within the landlord's team. The original FK to contractors(id) was a
-- leftover from an early marketplace-first design and would have rejected
-- any real assignment (a users.id is not a contractors.id), which is why
-- assignment was never actually functional. Nic-confirmed (S442): a
-- landlord-side assignment goes to a team member.
--
-- SAFE — NO BACKFILL NEEDED: zero maintenance_requests rows have a non-null
-- contractor_id (assignment was never wired end to end), so there is
-- nothing to migrate. ON DELETE SET NULL: removing a worker unassigns their
-- open requests rather than blocking the user delete.

ALTER TABLE public.maintenance_requests
  DROP CONSTRAINT IF EXISTS maintenance_requests_contractor_id_fkey;

ALTER TABLE public.maintenance_requests
  ADD CONSTRAINT maintenance_requests_contractor_id_fkey
    FOREIGN KEY (contractor_id) REFERENCES public.users(id) ON DELETE SET NULL;
