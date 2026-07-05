-- S526 (Nic): some jurisdictions run WEEKLY leases. Per-property toggle: when
-- on, the automatic lease-draft threshold for long stays drops from 30 days
-- to 7 (see services/bookingLeaseDraft.ts). Default off = monthly posture.
-- No backfill needed (default false preserves current behavior).
ALTER TABLE properties ADD COLUMN IF NOT EXISTS weekly_lease_mode boolean NOT NULL DEFAULT false;
