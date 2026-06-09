-- S101: persistent log of every email send attempt.
--
-- Why: pre-S101 the central send() helper at services/email.ts swallowed
-- all errors with a console.error and returned nothing. Failures were
-- invisible — when a tenant onboarding email bounced, the landlord had
-- no surface to see it (TODO at landlords.ts:629). This table is the
-- backing store for the email-failures surface.
--
-- Every send() call writes one row regardless of outcome:
--   status='sent'   — Resend accepted the message
--   status='failed' — Resend rejected OR the call threw (timeout, etc).
--                     error_message captures the cause.
--
-- Optional context fields let callers attribute a send to a specific
-- landlord and related entity so per-landlord queries can filter:
--   landlord_id          → which landlord this concerns (NULL = global/system)
--   related_entity_type  → e.g. 'tenant', 'lease', 'invitation', 'background_check'
--   related_entity_id    → uuid of that entity
--   metadata             → jsonb escape hatch for per-category fields
--
-- Backwards-compatible refactor: send() ctx is optional. Existing 16
-- senders that don't pass ctx still get a row (with NULL metadata) so
-- the global failure list works for ops immediately. Per-landlord
-- filterability arrives as individual senders get their ctx threaded
-- through in follow-up sessions.

CREATE TABLE email_send_log (
    id                   uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    to_email             text NOT NULL,
    subject              text NOT NULL,
    category             text,
    status               text NOT NULL,
    error_message        text,
    landlord_id          uuid REFERENCES landlords(id) ON DELETE SET NULL,
    related_entity_type  text,
    related_entity_id    uuid,
    metadata             jsonb,
    created_at           timestamp with time zone NOT NULL DEFAULT now(),

    CONSTRAINT email_send_log_status_check
      CHECK (status = ANY (ARRAY['sent', 'failed']))
);

-- Per-landlord recent-failures lookup (the landlord UI query).
CREATE INDEX idx_email_send_log_landlord_status_created
  ON email_send_log(landlord_id, status, created_at DESC);

-- Global recent-failures lookup (the admin/ops query). Partial index
-- because failures are the rare case worth fast access.
CREATE INDEX idx_email_send_log_failed_recent
  ON email_send_log(created_at DESC) WHERE status = 'failed';
