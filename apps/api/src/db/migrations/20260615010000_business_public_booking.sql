-- S507: customer self-service booking.
--
-- Adds a public-facing booking surface per business:
--
--   businesses.public_booking_enabled boolean  — owner toggle
--   businesses.public_booking_slug    text     — URL-safe identifier (UNIQUE)
--   businesses.public_booking_intro   text     — message shown to customers
--   businesses.business_hours         jsonb    — open/close per weekday
--
--   business_bookable_services         — catalog of services offered for booking
--                                        (name, duration, price, description)
--
-- Flow:
--   1. Owner enables public_booking_enabled + sets slug ("nics-garage")
--   2. Owner adds services (e.g., "Oil change — 45min, $80")
--   3. Customer visits marketing-site /book/nics-garage
--   4. Public API computes available slots from business_hours minus
--      existing appointments minus the new service's duration
--   5. Customer picks a slot, supplies name/email/phone
--   6. Public POST creates business_customers row (or matches by email)
--      + appointments row + emails confirmation to customer + owner
--
-- business_hours shape:
--   {
--     "0": null,                            // Sunday closed
--     "1": { "open": "09:00", "close": "17:00" },  // Monday
--     ...
--     "6": null                             // Saturday closed
--   }
--   Keys are JS day-of-week (0=Sunday..6=Saturday). null = closed.
--   Default applied at app layer when value is empty.
--
-- SAFE — additive only, no backfill. New businesses get public booking
-- disabled. Existing businesses see zero behavior change until owner
-- enables it.

ALTER TABLE public.businesses
  ADD COLUMN public_booking_enabled boolean DEFAULT FALSE NOT NULL,
  ADD COLUMN public_booking_slug    text,
  ADD COLUMN public_booking_intro   text,
  ADD COLUMN business_hours         jsonb DEFAULT '{}'::jsonb NOT NULL,
  ADD CONSTRAINT businesses_public_booking_slug_format CHECK (
    public_booking_slug IS NULL
    OR (
      public_booking_slug ~ '^[a-z0-9][a-z0-9-]{1,60}$'
      AND public_booking_slug !~ '--'
    )
  ),
  -- When enabled, slug must be set so the URL resolves.
  ADD CONSTRAINT businesses_public_booking_enabled_needs_slug CHECK (
    public_booking_enabled = FALSE OR public_booking_slug IS NOT NULL
  );

CREATE UNIQUE INDEX idx_businesses_public_booking_slug
  ON public.businesses (public_booking_slug)
  WHERE public_booking_slug IS NOT NULL;

CREATE TABLE public.business_bookable_services (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
    name text NOT NULL,
    description text,
    duration_minutes integer NOT NULL,
    price numeric(10,2),                     -- nullable — owner can hide price
    is_active boolean DEFAULT TRUE NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT business_bookable_services_pkey PRIMARY KEY (id),
    CONSTRAINT business_bookable_services_duration_positive
      CHECK (duration_minutes > 0 AND duration_minutes <= (24 * 60)),
    CONSTRAINT business_bookable_services_price_nonneg
      CHECK (price IS NULL OR price >= 0)
);
CREATE INDEX idx_business_bookable_services_business
  ON public.business_bookable_services (business_id, is_active, sort_order);

CREATE TRIGGER trg_business_bookable_services_updated_at
  BEFORE UPDATE ON public.business_bookable_services
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

COMMENT ON COLUMN public.businesses.public_booking_slug IS
  'S507 URL-safe identifier used in /book/:slug. Lowercase a-z, digits, single hyphens; 2-61 chars; no leading hyphen, no consecutive hyphens.';
COMMENT ON COLUMN public.businesses.business_hours IS
  'S507 weekly hours map. Keys "0"-"6" (Sun-Sat) → {open, close} as HH:MM strings, or null for closed.';
COMMENT ON TABLE public.business_bookable_services IS
  'S507 catalog of services offered for public booking. Each service has a duration + optional price; the booking page lets customers pick one.';
