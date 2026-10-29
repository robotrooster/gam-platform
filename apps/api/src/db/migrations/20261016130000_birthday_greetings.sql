-- 10/13 evening (Nic) — A HAPPY-BIRTHDAY EMAIL FROM GAM, TO TENANTS AND LANDLORDS.
--
-- Nic: "emailing tenants on their birthday and saying, Hey, happy birthday
-- from GAM ... just like a happy birthday message. Thank you for using GAM,
-- that sort of thing." He chose TENANTS + LANDLORDS, and "landlords need a
-- birthday on their profile".
--
-- 1. users.date_of_birth — a landlord's own birthday, typed on Settings →
--    Account (PATCH /api/auth/me). On the USER, not the company: the account
--    owns its companies, and a birthday belongs to the person signed in, not
--    to an LLC (one person can own several). Optional; NULL = none on file,
--    and nobody with no birthday is ever emailed. A tenant's birthday is NOT
--    read from here — it comes from tenants.date_of_birth (copied off the
--    signed lease).
--
-- 2. birthday_greetings — the sent-log that keeps it to ONCE PER PERSON PER
--    YEAR. jobs/birthdayEmails.ts claims (user_id, greeting_year) before it
--    sends, so two runs on the same morning can never both send; a send that
--    did not go out gives the claim back (deletes its own claim). greeting_year
--    is the Phoenix year of the morning it was sent. A row for a greeting that
--    went out is kept; nothing else deletes them.
--
-- No money column. Expand-only; no backfill (the first morning after the
-- deploy writes the first rows). Idempotent. Safe to drop with the code that
-- reads it.

ALTER TABLE users ADD COLUMN IF NOT EXISTS date_of_birth date;

COMMENT ON COLUMN users.date_of_birth IS
  '10/13 (Nic): a landlord''s own birthday, typed on Settings → Account, for the happy-birthday email (jobs/birthdayEmails.ts). Optional. Tenants'' birthdays live on tenants.date_of_birth.';

CREATE TABLE IF NOT EXISTS birthday_greetings (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  greeting_year  integer NOT NULL,
  sent_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT birthday_greetings_once_a_year UNIQUE (user_id, greeting_year)
);

COMMENT ON TABLE birthday_greetings IS
  '10/13 (Nic): one row per person per year a happy-birthday email went out (jobs/birthdayEmails.ts). The unique (user_id, greeting_year) is what keeps it to once a year.';
