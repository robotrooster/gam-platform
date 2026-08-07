-- S592 (Nic): add the `portfolio_manager` user role.
--
-- WHY: "portfolio manager" (a GAM-side closing agent / account manager) was
-- previously modeled as the `admin` role with data filtered by portfolio — a
-- deny-list posture where every admin endpoint is reachable unless individually
-- gated (the S592 comb found three such holes). We are making it a first-class,
-- scoped role with its own portal (the former admin-ops app), walled off from
-- /api/admin. This migration only ADDS the allowed value; nothing is migrated
-- onto it yet (existing PMs stay `admin`/`super_admin` until P5 reassigns them).
--
-- Single source of truth: mirrors packages/shared USER_ROLES (portfolio_manager
-- appended there in the same change).
--
-- Safe change: CHECK constraints can't be altered in place, so drop + re-add
-- with the extended value list. No data rewrite, no backfill needed.

ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_role_check;

ALTER TABLE public.users
  ADD CONSTRAINT users_role_check CHECK (role = ANY (ARRAY[
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
    'fitness_user'::text,
    'contact'::text,
    'portfolio_manager'::text
  ]));
