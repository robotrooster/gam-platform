-- PM readiness 4 — THE OWNER STATEMENT, ACTUALLY DELIVERED.
--
-- services/ownerStatement has computed a complete statement since S644, and
-- the owner-facing routes have shown it since S645. Nobody was ever SENT one.
-- An owner whose park is run by a manager on GAM does not log in most months;
-- the statement existed only for whoever asked for it, and evaporated after.
--
-- This is the record that the month's statement went to that owner, and the
-- guard that it never goes twice. The job claims the row (status 'sending')
-- with INSERT ... ON CONFLICT DO NOTHING before it renders or sends anything,
-- so two API processes, a re-run by hand and a catch-up run on a later day
-- can never all email the same month. It is also what the owner-facing
-- endpoints read to say "sent on X" beside a statement.
--
-- ONE ROW PER OWNER ENTITY, MANAGER, MONTH AND ADDRESS. The statement itself
-- is scoped to one manager (an owner with parks under two managers gets two
-- statements — two sets of fees, two people to ring about them), so the send
-- is scoped the same way, or the second manager's statement would be
-- swallowed as a duplicate of the first. pm_company_id is NOT NULL for that
-- reason: a self-managed owner is the landlord of their own park and already
-- gets the monthly property report (jobs/monthlyPropertyReportEmail); this is
-- the document a MANAGER owes them.
--
--   period_month         the month the statement covers, its first day
--   recipient_key        the address, lowercased (one email per address even
--                        when the same person is reachable twice)
--   property_ids         the properties the statement covered at send time
--   attempts             sends tried
--   provider_message_id  the mail service's id when it accepted the email
--
-- Keep everything: rows are never deleted. It records a delivery, not a
-- dollar — no amounts are stored here, so no audit_row_change trigger (the
-- same call monthly_report_sends made).
--
-- Safe to apply before the code ships: a new table nothing reads yet.

CREATE TABLE IF NOT EXISTS owner_statement_sends (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  landlord_id          uuid NOT NULL REFERENCES landlords(id),
  pm_company_id        uuid NOT NULL REFERENCES pm_companies(id),
  period_month         date NOT NULL,
  recipient_key        text NOT NULL,
  email                text NOT NULL,
  user_id              uuid REFERENCES users(id),
  property_ids         uuid[] NOT NULL DEFAULT '{}',
  status               text NOT NULL DEFAULT 'sending',
  attempts             integer NOT NULL DEFAULT 1,
  provider_message_id  text,
  last_error           text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  sent_at              timestamptz
);

-- Postgres has no ADD CONSTRAINT IF NOT EXISTS, and the migration suite
-- replays every file twice: drop first, every time.
ALTER TABLE owner_statement_sends DROP CONSTRAINT IF EXISTS owner_statement_sends_status_check;
ALTER TABLE owner_statement_sends
  ADD CONSTRAINT owner_statement_sends_status_check CHECK (status IN ('sending', 'sent', 'not_sent'));

ALTER TABLE owner_statement_sends DROP CONSTRAINT IF EXISTS owner_statement_sends_month_first_day;
ALTER TABLE owner_statement_sends
  ADD CONSTRAINT owner_statement_sends_month_first_day
  CHECK (period_month = date_trunc('month', period_month)::date);

ALTER TABLE owner_statement_sends DROP CONSTRAINT IF EXISTS owner_statement_sends_attempts_check;
ALTER TABLE owner_statement_sends
  ADD CONSTRAINT owner_statement_sends_attempts_check CHECK (attempts >= 1);

-- The guard itself: the claim the job takes before it sends.
ALTER TABLE owner_statement_sends DROP CONSTRAINT IF EXISTS owner_statement_sends_once;
ALTER TABLE owner_statement_sends
  ADD CONSTRAINT owner_statement_sends_once
  UNIQUE (landlord_id, pm_company_id, period_month, recipient_key);

-- The job's own sweep ("what is still unsent for this month") and the
-- stuck-send check.
CREATE INDEX IF NOT EXISTS owner_statement_sends_month_idx
  ON owner_statement_sends (period_month, status);

-- What the owner-facing endpoints read: the latest send for this statement.
CREATE INDEX IF NOT EXISTS owner_statement_sends_statement_idx
  ON owner_statement_sends (landlord_id, pm_company_id, period_month);

COMMENT ON TABLE owner_statement_sends IS
  'PM readiness 4: one row per owner entity, manager, statement month and address — the record that the statement was emailed, and the claim that stops it being emailed twice.';
COMMENT ON COLUMN owner_statement_sends.pm_company_id IS
  'The manager whose statement this is. NOT NULL: an owner with two managers gets two statements, and one shared row would swallow the second.';
COMMENT ON COLUMN owner_statement_sends.status IS
  '''sending'' is the claim taken before the email goes out; ''sent'' the mail service accepted it; ''not_sent'' it refused (tried again on a later run, while the month''s window is open).';
