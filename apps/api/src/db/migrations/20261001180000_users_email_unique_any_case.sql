-- S654 (security review): users.email was unique only by exact spelling, so
-- 'Landlord@x.com' and 'landlord@x.com' could be two logins. Several routes
-- looked accounts up by exact spelling and, missing a differently-cased
-- landlord, inserted a second 'tenant' login on the landlord's address and
-- handed out its activation link. The routes now look up by lower(email); this
-- makes the database refuse a second login on the same address in any case,
-- from every door. Production and demo hold no such duplicates today (checked).
--
-- Additive (expand). No backfill needed.
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_email_lower ON users (lower(email));
