-- Add 'business_owner' and 'business_staff' to users_role_check.
--
-- WHY: Phase 1a.1 opens a new entity type — `businesses` — for service
-- operators (trash hauling, maintenance crews, mobile rentals, equipment
-- rentals, etc.) running their own portal at apps/business. Mirrors the
-- landlord/landlord-staff pattern:
--   businesses.owner_user_id  → users.id where role='business_owner'
--   business_users.user_id    → users.id where role='business_staff'
-- (analog of landlords.user_id + property_manager_scopes.user_id).
--
-- Two distinct roles keep the JWT auth + portal entry decisions clean:
-- owners land in the business portal nav with full scope; staff land
-- with the per-business permissions JSON resolved at login. Same shape
-- as how property_manager users get scope-resolved at /api/auth/login.
--
-- The businesses table + business_users + business_customers land in
-- subsequent migrations (one concern per file).
--
-- SAFE — NO BACKFILL NEEDED: zero existing users carry these role
-- values (the values don't exist in the prior CHECK enum).

ALTER TABLE public.users
  DROP CONSTRAINT users_role_check;

ALTER TABLE public.users
  ADD CONSTRAINT users_role_check
    CHECK (role = ANY (ARRAY[
      'admin'::text,
      'super_admin'::text,
      'landlord'::text,
      'tenant'::text,
      'bookkeeper'::text,
      'property_manager'::text,
      'onsite_manager'::text,
      'maintenance'::text,
      'business_owner'::text,
      'business_staff'::text
    ]));
