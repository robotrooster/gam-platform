-- S280: per-account login lockout.
--
-- Adds failed-login tracking to `users` so credential-stuffing
-- attacks can't grind through arbitrary passwords. The existing
-- per-IP rate limiter (100 req / 15 min on /api/auth/*, S277 audit)
-- doesn't help against distributed attacks spread across many IPs.
--
-- Schema:
--   failed_login_count int  NOT NULL DEFAULT 0  — bumped on bad password
--   locked_until       tstz                      — set when count >= 5;
--                                                  login route gates on it.
--
-- Cleared by: successful login, password reset, lockout-window expiry
-- (gate compares locked_until > NOW(), so an expired stamp just stops
-- gating without needing a sweep cron).
--
-- No backfill needed — existing rows get the column default (0/NULL),
-- which is the "no failures, not locked" state.

ALTER TABLE public.users
  ADD COLUMN failed_login_count integer NOT NULL DEFAULT 0,
  ADD COLUMN locked_until       timestamp with time zone;
