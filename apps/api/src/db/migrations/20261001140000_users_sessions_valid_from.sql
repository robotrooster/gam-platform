-- S654: sessions renew while in use (POST /auth/refresh), so a session no
-- longer dies on a fixed 7-day timer. That means a password reset must END
-- the other sessions explicitly — before this, the thief's pass died within
-- seven days on its own. Every password write stamps this column; /auth/me
-- and /auth/refresh reject a pass whose iat predates it.
--
-- Nullable, no backfill: an existing pass stays valid until it expires or the
-- password changes. Safe to drop if ever reverted (nothing else reads it).
ALTER TABLE users ADD COLUMN IF NOT EXISTS sessions_valid_from timestamptz;
