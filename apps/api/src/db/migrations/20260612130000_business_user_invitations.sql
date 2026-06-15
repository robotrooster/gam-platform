-- Phase 1a.1 — business_user_invitations table.
--
-- WHY: Owners invite staff by email before the staff member has a GAM
-- account. The invitation lives separately from business_users because
-- business_users.user_id is NOT NULL — the users row doesn't exist
-- until the invitee accepts and we create it.
--
-- Pattern mirrors sublessee_invitations (S247): token + expiry, single
-- accept call creates the users row + the scope row in one transaction,
-- on-accept marks the invitation row 'accepted' so subsequent token
-- replays 409.
--
-- The business_users.status='invited' value in the S453 migration is
-- intentionally retained for a DIFFERENT future flow: in-app invitation
-- of an EXISTING user (where user_id is known up front). That path
-- skips this invitation table.
--
-- SAFE — NO BACKFILL NEEDED: table is brand new, no rows exist.

CREATE TABLE public.business_user_invitations (
    id uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
    business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
    invited_by_user_id uuid NOT NULL REFERENCES public.users(id),
    token text NOT NULL,
    email text NOT NULL,
    staff_role text NOT NULL,
    permissions jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'sent'::text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    accepted_user_id uuid REFERENCES public.users(id),
    accepted_at timestamp with time zone,
    cancelled_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT business_user_invitations_token_unique UNIQUE (token),
    CONSTRAINT business_user_invitations_status_check
      CHECK (status = ANY (ARRAY[
        'sent'::text, 'accepted'::text, 'expired'::text, 'cancelled'::text
      ])),
    -- Mirror business_users.staff_role enum exactly (single source of
    -- truth lives in packages/shared via S454; this CHECK is the DB
    -- guard).
    CONSTRAINT business_user_invitations_staff_role_check
      CHECK (staff_role = ANY (ARRAY[
        'manager'::text, 'dispatcher'::text, 'driver'::text, 'office'::text
      ])),
    -- accepted rows must carry accepted_user_id + accepted_at.
    CONSTRAINT business_user_invitations_accepted_audit
      CHECK (
        status <> 'accepted'
        OR (accepted_user_id IS NOT NULL AND accepted_at IS NOT NULL)
      )
);

-- Lookup by token (the accept route's only handle).
CREATE INDEX idx_business_user_invitations_token
  ON public.business_user_invitations (token);
-- Owner-side: list pending invitations for a business.
CREATE INDEX idx_business_user_invitations_business
  ON public.business_user_invitations (business_id, status)
  WHERE status = 'sent';

CREATE TRIGGER trg_business_user_invitations_updated_at
  BEFORE UPDATE ON public.business_user_invitations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
