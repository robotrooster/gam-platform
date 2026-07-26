-- Why: notifications.user_id FK had no ON DELETE clause (defaulted to NO
-- ACTION), so deleting a user while any of their notifications rows survive
-- raises a 23503 FK violation. This is (a) inconsistent with the sibling
-- tenant_notifications.user_id FK, which already ON DELETE CASCADEs, and with
-- the dominant user-FK pattern across the schema (20 CASCADE vs 6 bare), and
-- (b) the correct product semantic: a notification is meaningless once its
-- recipient user is gone, so it should die with the user.
--
-- Practical trigger: several booking/lease routes emit notifications
-- fire-and-forget (not awaited on the response), which in the test suite race
-- into cleanupAllSchema's DELETE window between the notifications wipe and the
-- users wipe, failing the users DELETE non-deterministically. CASCADE makes
-- that cleanup timing-independent instead of order/timing-fragile.
--
-- No backfill needed — pure constraint swap; existing rows unaffected.

ALTER TABLE public.notifications
  DROP CONSTRAINT notifications_user_id_fkey,
  ADD CONSTRAINT notifications_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
