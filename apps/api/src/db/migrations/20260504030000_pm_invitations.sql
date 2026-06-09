-- S112: pm_invitations — email + accept-token flow for PM company staff.
--
-- Parallel to the existing `invitations` table (which keys on landlord_id +
-- in-house role). PM staff have a different scope (pm_company_id) and a
-- different role enum (PM_STAFF_ROLES from S108: owner/manager/staff), so
-- a separate table keeps each subsystem's invariants clean rather than
-- loosening the existing invitations CHECK constraints. Same shape /
-- accept-flow contract as S80.
--
-- Token stored verbatim (URL-safe random string). status flow:
--   pending → accepted (when recipient calls /accept)
--   pending → expired (when expires_at passes; the existing
--     processInvitationExpiry cron sweeps both tables — extended in S112)
--   pending → revoked (when company owner deletes the invitation)
--
-- Partial UNIQUE on (pm_company_id, lower(email)) WHERE status='pending'
-- prevents two concurrent pending invites to the same email for the same
-- company — accepted/expired/revoked rows are kept for audit and don't
-- block fresh re-invites.

CREATE TABLE pm_invitations (
    id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    pm_company_id       uuid NOT NULL REFERENCES pm_companies(id) ON DELETE CASCADE,
    email               text NOT NULL,
    role                text NOT NULL DEFAULT 'staff',
    permissions         jsonb NOT NULL DEFAULT '{}'::jsonb,
    invited_by_user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status              text NOT NULL DEFAULT 'pending',
    token               text NOT NULL,
    expires_at          timestamp with time zone NOT NULL,
    accepted_at         timestamp with time zone,
    accepted_user_id    uuid REFERENCES users(id) ON DELETE SET NULL,
    revoked_at          timestamp with time zone,
    revoked_by_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at          timestamp with time zone NOT NULL DEFAULT now(),

    CONSTRAINT pm_invitations_role_check
      CHECK (role = ANY (ARRAY['owner', 'manager', 'staff'])),
    CONSTRAINT pm_invitations_status_check
      CHECK (status = ANY (ARRAY['pending', 'accepted', 'expired', 'revoked']))
);

CREATE UNIQUE INDEX pm_invitations_token_unique ON pm_invitations(token);
CREATE UNIQUE INDEX pm_invitations_unique_pending
  ON pm_invitations(pm_company_id, lower(email))
  WHERE status = 'pending';
CREATE INDEX idx_pm_invitations_company_status
  ON pm_invitations(pm_company_id, status, created_at DESC);
CREATE INDEX idx_pm_invitations_email_status
  ON pm_invitations(lower(email), status) WHERE status = 'pending';
