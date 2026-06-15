-- Phase 1a.1 — business_customers table.
--
-- WHY: Each business has its own customer roster (homes/businesses that
-- receive the service — trash pickup, maintenance call, equipment
-- rental). Analog of landlords' tenants table: scoped to one business,
-- the business CRUDs them through the business portal.
--
-- Distinct from `tenants` (GAM platform residents) and `pos_customers`
-- (POS-merchant customer roster on the landlord side). The three serve
-- different domains:
--   tenants            → residential lease/rent context
--   pos_customers      → POS-merchant credit/charge accounts under a landlord
--   business_customers → service-business customer roster under a business
--
-- customer_type accommodates both individual and B2B customers — a trash
-- company's customer might be a household OR a strip mall property mgr.
-- For B2B customers, company_name carries the entity; first/last name
-- holds the contact person on record.
--
-- Address is required because routing requires lat/lon for every
-- customer. lat/lon are populated on customer create via an in-house
-- geocoder (next session — Phase 1a.2 work). They stay nullable until
-- then so the table can be populated before the geocoder lands.
--
-- SAFE — NO BACKFILL NEEDED: table is brand new, no rows exist.

CREATE TABLE public.business_customers (
    id uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
    business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
    customer_type text NOT NULL,
    company_name text,
    first_name text NOT NULL,
    last_name text NOT NULL,
    email text,
    phone text,
    street1 text NOT NULL,
    street2 text,
    city text NOT NULL,
    state text NOT NULL,
    zip text NOT NULL,
    -- Geocoded coordinates for routing — populated by a post-insert
    -- geocode call (Phase 1a.2). NULL means "not geocoded yet"; the
    -- routing engine will skip customers without coords until they
    -- backfill.
    lat numeric(10,7),
    lon numeric(10,7),
    notes text,
    status text DEFAULT 'active'::text NOT NULL,
    -- Linked GAM user account, if the customer signs up to a portal of
    -- their own (future feature; customers can view their own service
    -- history). NULL by default — most customers are roster-only.
    user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    archived_at timestamp with time zone,
    CONSTRAINT business_customers_status_check
      CHECK (status = ANY (ARRAY[
        'active'::text, 'archived'::text
      ])),
    CONSTRAINT business_customers_customer_type_check
      CHECK (customer_type = ANY (ARRAY[
        'individual'::text, 'business'::text
      ])),
    CONSTRAINT business_customers_business_name_required
      CHECK (
        customer_type = 'individual'::text
        OR (customer_type = 'business'::text AND company_name IS NOT NULL AND length(company_name) > 0)
      )
);

CREATE INDEX idx_business_customers_business
  ON public.business_customers (business_id) WHERE status = 'active';
CREATE INDEX idx_business_customers_email
  ON public.business_customers (business_id, lower(email)) WHERE email IS NOT NULL;
-- Geocoded customers can be selected for route generation in one filter.
CREATE INDEX idx_business_customers_geocoded
  ON public.business_customers (business_id)
  WHERE status = 'active' AND lat IS NOT NULL AND lon IS NOT NULL;

CREATE TRIGGER trg_business_customers_updated_at
  BEFORE UPDATE ON public.business_customers
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
