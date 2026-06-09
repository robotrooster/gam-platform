-- S157: pm_property_invitations — bidirectional consent handshake for
-- linking a property to a third-party PM company.
--
-- Why this exists separately from the existing pm_invitations table (S112):
--   pm_invitations  = staff-onboarding (invite a person to join a PM company)
--   pm_property_invitations (this) = property-linkage (mutual consent
--     between an owner and a PM company before a property's pm_company_id
--     gets set and money starts routing)
--
-- Different invariants → different tables. Mixing them would force the
-- pm_invitations CHECK constraints to balloon and would muddy the
-- property-vs-staff distinction in the accept handlers.
--
-- Two directions (S156 Q4 design):
--
--   direction='owner_to_pm' — owner says "I hire you to manage property X."
--     Owner clicks Send from landlord portal. Email lands at pm_company's
--     primary contact (or any active staff with role='owner'). On accept,
--     the route writes properties.pm_company_id + pm_fee_plan_id (if
--     proposed_fee_plan_id was bundled) and notifies both parties.
--
--   direction='pm_to_owner' — PM says "I manage property X; come see it."
--     PM clicks Send from PM portal. Email lands at the property's
--     landlord owner_email (or current owner-user if registered). On
--     accept, same write-through behavior. If the email's owner doesn't
--     yet have a GAM account, the accept-token URL routes to a simplified
--     landlord signup that pre-populates the property/landlord pairing.
--
-- Conflict handling: if the property already has pm_company_id set when
-- this invitation is accepted, the accept-handler returns 409 with a
-- conflict body; the UI surfaces a "currently managed by X — replace?"
-- confirm. Confirming reroutes by setting properties.pm_company_id /
-- pm_fee_plan_id to the new pm_company + plan and audit-logs the
-- replacement. The previous pm_company's link is severed; in-flight
-- accruals already captured for the old PM are NOT clawed back (audit
-- trail invariant from S110 stays intact).
--
-- Token: URL-safe random string, stored verbatim. Same shape as the
-- staff-invitation pm_invitations table — the existing
-- processInvitationExpiry cron will be extended to sweep this table too.
--
-- Status flow:
--   pending → accepted   (recipient calls /accept; properties.pm_company_id written)
--   pending → rejected   (recipient calls /reject; rejected_reason captured)
--   pending → revoked    (sender deletes before action; revoked_by_user_id captured)
--   pending → expired    (cron sweeps when expires_at passes)
--
-- Partial unique on (pm_company_id, property_id) WHERE status='pending'
-- prevents duplicate concurrent invites for the same pairing in either
-- direction. accepted/rejected/expired/revoked rows kept for audit and
-- don't block fresh re-invites.
--
-- No backfill needed.

CREATE TABLE pm_property_invitations (
    id                      uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    direction               text NOT NULL,
    pm_company_id           uuid NOT NULL REFERENCES pm_companies(id) ON DELETE CASCADE,
    property_id             uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    landlord_id             uuid NOT NULL REFERENCES landlords(id) ON DELETE CASCADE,
    invited_email           text NOT NULL,
    invited_by_user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    proposed_scope          text NOT NULL DEFAULT 'manage',
    proposed_fee_plan_id    uuid REFERENCES pm_fee_plans(id) ON DELETE SET NULL,
    token                   text NOT NULL,
    status                  text NOT NULL DEFAULT 'pending',
    expires_at              timestamp with time zone NOT NULL,
    accepted_at             timestamp with time zone,
    accepted_user_id        uuid REFERENCES users(id) ON DELETE SET NULL,
    rejected_at             timestamp with time zone,
    rejected_reason         text,
    revoked_at              timestamp with time zone,
    revoked_by_user_id      uuid REFERENCES users(id) ON DELETE SET NULL,
    replaced_pm_company_id  uuid REFERENCES pm_companies(id) ON DELETE SET NULL,
    created_at              timestamp with time zone NOT NULL DEFAULT now(),

    CONSTRAINT pm_property_invitations_direction_check
      CHECK (direction = ANY (ARRAY['owner_to_pm', 'pm_to_owner'])),
    CONSTRAINT pm_property_invitations_scope_check
      CHECK (proposed_scope = ANY (ARRAY['manage', 'view'])),
    CONSTRAINT pm_property_invitations_status_check
      CHECK (status = ANY (ARRAY['pending', 'accepted', 'rejected', 'expired', 'revoked']))
);

CREATE UNIQUE INDEX pm_property_invitations_token_unique
  ON pm_property_invitations(token);

CREATE UNIQUE INDEX pm_property_invitations_unique_pending
  ON pm_property_invitations(pm_company_id, property_id)
  WHERE status = 'pending';

CREATE INDEX idx_pm_property_invitations_pm_status
  ON pm_property_invitations(pm_company_id, status, created_at DESC);

CREATE INDEX idx_pm_property_invitations_property_status
  ON pm_property_invitations(property_id, status, created_at DESC);

CREATE INDEX idx_pm_property_invitations_landlord_status
  ON pm_property_invitations(landlord_id, status, created_at DESC);

CREATE INDEX idx_pm_property_invitations_email_status
  ON pm_property_invitations(lower(invited_email), status)
  WHERE status = 'pending';
