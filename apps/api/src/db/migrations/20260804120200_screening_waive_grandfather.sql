-- S579: screening grandfather (waive) — status value + audit trail.
--
-- WHY: a grandfathered sitting tenant skips the background check. The gate the
-- tenant portal already reads is `tenants.background_check_status` (an override
-- consumed by /background/status; the portal treats anything other than
-- not_started/submitted/denied as "pass"). Add a first-class 'waived' value so
-- a grandfather is auditable and distinct from a real 'approved' check.
--
-- The grandfather is never a silent skip: record WHO waived it, WHEN, and that
-- the landlord ATTESTED the person is an existing resident (false attestation =
-- landlord liability). GAM keeps everything — this is the audit trail. Stored
-- on pending_tenant_intents (the onboarding action that grants the grandfather).

ALTER TABLE public.tenants
  DROP CONSTRAINT IF EXISTS tenants_background_check_status_check;
ALTER TABLE public.tenants
  ADD CONSTRAINT tenants_background_check_status_check
  CHECK (background_check_status = ANY (ARRAY[
    'not_started'::text, 'submitted'::text, 'approved'::text,
    'denied'::text, 'cancelled'::text, 'expired'::text, 'waived'::text]));

ALTER TABLE public.pending_tenant_intents
  ADD COLUMN IF NOT EXISTS screening_waived    boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS screening_waived_by uuid REFERENCES public.users(id),
  ADD COLUMN IF NOT EXISTS screening_waived_at timestamptz,
  ADD COLUMN IF NOT EXISTS screening_attested  boolean NOT NULL DEFAULT false;
