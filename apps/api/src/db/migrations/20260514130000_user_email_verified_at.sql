-- S284: audit timestamp for email verification.
--
-- S281 shipped the verification flow (email_verified bool flips
-- TRUE on /verify-email + clears the token). The audit column
-- captures WHEN that flip happened — useful for compliance
-- investigations ("when did this account get verified?") and
-- abuse triage ("did this account verify before/after the
-- incident?"). The boolean alone can't answer either.
--
-- Schema:
--   email_verified_at  tstz NULL  — populated on successful
--                                   verification; stays NULL for
--                                   unverified accounts.
--
-- No backfill — accounts that verified pre-S284 have NULL here
-- because we don't have a reliable timestamp for them. Going
-- forward, every verify-email transition writes both columns.

ALTER TABLE public.users
  ADD COLUMN email_verified_at timestamp with time zone;
