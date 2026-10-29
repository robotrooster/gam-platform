-- 10/12 (Nic) — THE MONTHLY PROPERTY REPORT, SENT ONCE PER ADDRESS PER MONTH
--
--   Emailed at month close (the 2nd, a local morning hour, after the 1st's
--   month-end runs) with the PDF attached, to the recipients the owner picked
--   (monthly_report_recipients).
--
-- One row per company, report month and address — the record that the
-- month's report went to that address, and the guard that it never goes
-- twice: the job claims the row (status 'sending') with INSERT ... ON
-- CONFLICT DO NOTHING before it sends, so two runs (two API processes, a
-- catch-up run on the 3rd) can never both email it. A send the mail service
-- did not accept is 'not_sent' and is tried again on a later run, at most
-- three times, while the month's catch-up window lasts.
--
--   report_month    the month the report covers, its first day
--   recipient_key   the address, lowercased (one email per address even when
--                   the same person is on the list twice)
--   property_ids    the properties that address's report covered (its
--                   recipient's scope at send time)
--   attempts        sends tried
--   provider_message_id  the mail service's id when it accepted the email
--
-- Keep everything: rows are never deleted. Not money: no journal trigger.
-- Safe to apply before the code ships: a new table nothing reads yet.

CREATE TABLE IF NOT EXISTS monthly_report_sends (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  landlord_id          uuid NOT NULL REFERENCES landlords(id),
  report_month         date NOT NULL,
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
  sent_at              timestamptz,
  CONSTRAINT monthly_report_sends_status_check CHECK (status IN ('sending', 'sent', 'not_sent')),
  CONSTRAINT monthly_report_sends_month_first_day CHECK (report_month = date_trunc('month', report_month)::date),
  CONSTRAINT monthly_report_sends_attempts_check CHECK (attempts >= 1),
  CONSTRAINT monthly_report_sends_once UNIQUE (landlord_id, report_month, recipient_key)
);

CREATE INDEX IF NOT EXISTS monthly_report_sends_month_idx
  ON monthly_report_sends (report_month, status);
