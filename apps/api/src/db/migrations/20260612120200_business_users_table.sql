-- Phase 1a.1 — business_users staff scoping table.
--
-- WHY: Analog of property_manager_scopes / onsite_manager_scopes /
-- maintenance_worker_scopes for the businesses entity. A business's
-- owner row lives on businesses.owner_user_id (single owner per
-- business); additional staff get rows in this table with a
-- per-business role + permissions JSON resolved at /api/auth/login
-- the same way property_manager_scopes are resolved today
-- (routes/auth.ts:getScopeForUser).
--
-- staff_role values match the operational positions Nic-locked at
-- S453 planning. Permissions JSON shape is intentionally heterogeneous
-- (mirrors property_manager_scopes.permissions) so future role-
-- specific sub-permissions can be added without a schema change.
--
-- SAFE — NO BACKFILL NEEDED: table is brand new, no rows exist.

CREATE TABLE public.business_users (
    id uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
    business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES public.users(id),
    staff_role text NOT NULL,
    permissions jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    invited_at timestamp with time zone,
    accepted_at timestamp with time zone,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT business_users_status_check
      CHECK (status = ANY (ARRAY[
        'active'::text, 'invited'::text, 'revoked'::text
      ])),
    CONSTRAINT business_users_staff_role_check
      CHECK (staff_role = ANY (ARRAY[
        'manager'::text,      -- full operational scope (post creation,
                              -- staff management, no ownership transfer)
        'dispatcher'::text,   -- route/appointment planning, customer mgmt
        'driver'::text,       -- driver-facing: view assigned routes, mark
                              -- stops complete, no admin/billing access
        'office'::text        -- billing/invoicing scope, no driver/route ops
      ])),
    CONSTRAINT business_users_unique_user_per_business UNIQUE (business_id, user_id)
);

CREATE INDEX idx_business_users_user
  ON public.business_users (user_id) WHERE status = 'active';
CREATE INDEX idx_business_users_business
  ON public.business_users (business_id, staff_role) WHERE status = 'active';

CREATE TRIGGER trg_business_users_updated_at
  BEFORE UPDATE ON public.business_users
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
