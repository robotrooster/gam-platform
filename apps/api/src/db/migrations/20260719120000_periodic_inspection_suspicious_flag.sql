-- S549: periodic inspection verdict loop — the front desk reviews a
-- tenant-self-directed periodic inspection (agent-guided photos) and either
-- PASSES it (existing sign + finalize path) or flags it SUSPICIOUS. Flagging
-- closes the tenant-submitted record (status -> cancelled, photos preserved
-- read-only) and auto-schedules an in-person physical inspection; these
-- columns record who flagged, why, and which follow-up inspection resulted.
-- The tenant is notified with neutral copy only — the reason never leaves
-- the landlord side.
-- No backfill needed: all columns nullable, existing rows unaffected.

ALTER TABLE unit_inspections
  ADD COLUMN flagged_suspicious_at timestamptz,
  ADD COLUMN flagged_by_user_id uuid REFERENCES users(id),
  ADD COLUMN flag_reason text,
  ADD COLUMN followup_inspection_id uuid REFERENCES unit_inspections(id);
