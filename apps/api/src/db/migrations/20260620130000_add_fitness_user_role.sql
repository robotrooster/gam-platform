-- Add 'fitness_user' to the users.role CHECK constraint.
--
-- WHY: The fitness tracker (apps/fitness, :3013) lets people who are NOT GAM
-- landlords/tenants sign up directly to try it out. Those accounts get a new
-- dedicated role 'fitness_user' (no landlord/tenant profile row) so they're
-- cleanly separable from real customers and can't slip into tenant/landlord
-- data. The role is mirrored in packages/shared USER_ROLES (single source of
-- truth). Existing portal users keep their own role and also use the fitness
-- app — fitness_user is only the "no other GAM relationship" case.
--
-- Safe: every currently-stored role is already in the new list, so the
-- re-validated constraint passes against existing rows. No backfill needed.

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;

ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (
  role = ANY (ARRAY[
    'admin'::text,
    'super_admin'::text,
    'landlord'::text,
    'tenant'::text,
    'bookkeeper'::text,
    'property_manager'::text,
    'onsite_manager'::text,
    'maintenance'::text,
    'business_owner'::text,
    'business_staff'::text,
    'fitness_user'::text
  ])
);
