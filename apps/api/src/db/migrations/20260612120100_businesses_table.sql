-- Phase 1a.1 — businesses entity.
--
-- WHY: New top-level operator entity for service businesses (trash
-- hauling, maintenance crews, mobile rentals, equipment rentals, etc.)
-- that operate independently of landlords. Each business gets its own
-- portal (apps/business, port 3012) like landlords get apps/landlord.
--
-- Pattern mirrors landlords:
--   businesses.owner_user_id → users.id where role='business_owner'
--   (staff scoping lives in a separate business_users table — next
--   migration, same arc.)
--
-- business_type is a CHECK-enforced enum starting with the four known
-- categories Nic-locked at S453 planning:
--   trash_hauling      — pickup-route operators (the first onboarded)
--   maintenance_crew   — mobile maintenance / repair routes
--   mobile_rental      — delivery-route mobile rental businesses
--   equipment_rental   — fixed-location equipment rental
--   other              — catch-all so the enum doesn't block onboarding
--                        of business types we haven't categorized yet
--
-- Adding new types in the future = forward migration to expand the CHECK.
-- Single source of truth lives in packages/shared (per CLAUDE.md enum rule)
-- when the API code first consumes the type column.
--
-- stripe_connect_account_id mirrors users.stripe_connect_account_id and
-- supports the destination-charge pattern (S113) when businesses start
-- taking customer payments through the platform. Nullable — populated
-- after the business completes Connect onboarding.
--
-- SAFE — NO BACKFILL NEEDED: table is brand new, no rows exist.

CREATE TABLE public.businesses (
    id uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
    owner_user_id uuid NOT NULL REFERENCES public.users(id),
    name text NOT NULL,
    business_type text NOT NULL,
    email text NOT NULL,
    phone text,
    street1 text,
    street2 text,
    city text,
    state text,
    zip text,
    ein text,
    stripe_connect_account_id text,
    connect_payouts_enabled boolean DEFAULT false NOT NULL,
    connect_details_submitted boolean DEFAULT false NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT businesses_status_check
      CHECK (status = ANY (ARRAY[
        'active'::text, 'suspended'::text, 'archived'::text
      ])),
    CONSTRAINT businesses_business_type_check
      CHECK (business_type = ANY (ARRAY[
        'trash_hauling'::text,
        'maintenance_crew'::text,
        'mobile_rental'::text,
        'equipment_rental'::text,
        'other'::text
      ]))
);

CREATE INDEX idx_businesses_owner ON public.businesses (owner_user_id);
CREATE INDEX idx_businesses_type
  ON public.businesses (business_type) WHERE status = 'active';

-- Mirror landlords' updated_at trigger pattern so callers don't have to
-- remember to set updated_at on every UPDATE.
CREATE TRIGGER trg_businesses_updated_at
  BEFORE UPDATE ON public.businesses
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
