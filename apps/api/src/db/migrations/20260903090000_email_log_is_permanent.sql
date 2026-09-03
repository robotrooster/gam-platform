-- S637 (Nic, DIRECTIVE): "We should keep a log of any emails sent, with no
-- way to be deleted by any super admin, even me. The log is the log. Any
-- conversations with landlords through that email chain, or reaching out to
-- these ghost landlords that signed up and did nothing — we should be
-- tracking our reach out attempts."
--
-- Two things stood in the way of that.
--
-- 1. email_send_log HELD NO BODY. It recorded who and what subject, never
--    what was said — so it could show that we reached out and never what we
--    reached out WITH. A record of outreach that cannot be read back is not
--    a record of the conversation.
--
-- 2. A DAILY PRUNE DELETED IT (S103, jobs/scheduler.ts). Sent rows decayed
--    at 90 days, failed at 365. That is right for sign-in codes and rent
--    receipts — the reason the prune exists is that those inflate the table
--    forever. It is wrong for a letter a person wrote to a customer.
--
-- So the line is drawn by CATEGORY: correspondence a human is party to is
-- permanent and immutable; machine chatter keeps its decay.
--
-- On the limit of this guarantee, stated plainly: a Postgres superuser can
-- always ALTER TABLE ... DISABLE TRIGGER. What this makes impossible is a
-- deletion through the application, by any role including super_admin and
-- the owner. Removing one of these rows now requires a deliberate,
-- out-of-band act against the database itself.

ALTER TABLE email_send_log
  ADD COLUMN IF NOT EXISTS body_text text;
ALTER TABLE email_send_log_archive
  ADD COLUMN IF NOT EXISTS body_text text;

COMMENT ON COLUMN email_send_log.body_text IS
  'S637: the words that were sent, for human correspondence. NULL for templated machine mail, whose content lives in services/email.ts.';

-- The categories a person is party to. Add to this list, never remove from
-- it: a category that has ever been permanent has rows relying on it.
CREATE OR REPLACE FUNCTION email_log_is_permanent(p_category text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(p_category, '') IN (
    'support_message',            -- an admin wrote this by hand
    'landlord_welcome_outreach'   -- our first reach-out to a new signup
  )
$$;

-- DELETE: refused outright for permanent rows.
CREATE OR REPLACE FUNCTION email_log_block_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF email_log_is_permanent(OLD.category) THEN
    RAISE EXCEPTION
      'email_send_log row % is correspondence (category=%) and cannot be deleted — the log is the log',
      OLD.id, OLD.category;
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_email_log_block_delete ON email_send_log;
CREATE TRIGGER trg_email_log_block_delete
  BEFORE DELETE ON email_send_log
  FOR EACH ROW EXECUTE FUNCTION email_log_block_delete();

-- UPDATE: delivery events still land (the Resend webhook stamps status,
-- last_event, provider ids), but what was SAID is frozen. Rewriting the
-- recipient, subject or body of a sent letter would be a quieter kind of
-- deletion.
CREATE OR REPLACE FUNCTION email_log_freeze_content()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF email_log_is_permanent(OLD.category) THEN
    IF NEW.to_email   IS DISTINCT FROM OLD.to_email
    OR NEW.subject    IS DISTINCT FROM OLD.subject
    OR NEW.body_text  IS DISTINCT FROM OLD.body_text
    OR NEW.category   IS DISTINCT FROM OLD.category
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION
        'email_send_log row % is correspondence — recipient, subject, body, category and timestamp are frozen',
        OLD.id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_email_log_freeze_content ON email_send_log;
CREATE TRIGGER trg_email_log_freeze_content
  BEFORE UPDATE ON email_send_log
  FOR EACH ROW EXECUTE FUNCTION email_log_freeze_content();

-- Reading a person's outreach history should not mean scanning the table.
CREATE INDEX IF NOT EXISTS idx_email_send_log_outreach
  ON email_send_log (LOWER(to_email), created_at DESC)
  WHERE email_log_is_permanent(category);
