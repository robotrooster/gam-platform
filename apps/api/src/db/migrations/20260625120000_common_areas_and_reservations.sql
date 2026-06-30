-- Common areas & amenity reservations (launch feature, 2026-06-25)
--
-- WHY: residents at a property need to reserve shared common areas
-- (clubhouse, pool, BBQ pavilion) for private use — parties etc. — and
-- everyone at the property needs to know when an amenity is unavailable
-- ("pool privately reserved 3–6pm on the 19th", "clubhouse closed for
-- chemical treatment"). Both are the same underlying record: a
-- time-bounded occupancy of a common area. A resident booking is a
-- request the landlord approves; a private rental / closure / event is
-- landlord-created and goes live immediately. When a row goes live and
-- notify_residents is set, the app fans out an amenity-unavailable
-- notification to every active resident of the property.
--
-- properties.amenities (text[]) is a free-text listing field and stays
-- as-is; common_areas is the reservable/announceable structured entity.
--
-- NO BACKFILL NEEDED — both tables are brand new.

-- ── common_areas ──────────────────────────────────────────────────────
CREATE TABLE public.common_areas (
    id                 uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
    property_id        uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
    -- denormalized for scoping/ownership checks (mirrors the pattern used
    -- across the codebase — canAccessLandlordResource gates on landlord_id)
    landlord_id        uuid NOT NULL REFERENCES public.landlords(id) ON DELETE CASCADE,
    name               text NOT NULL,
    description        text,
    -- some amenities are announce-only (a pool you can't book privately but
    -- can be closed for treatment); reservable=false hides the request flow
    reservable         boolean NOT NULL DEFAULT true,
    -- when true, a resident request lands as 'pending' for landlord decision;
    -- when false, resident requests auto-approve and go live immediately
    requires_approval  boolean NOT NULL DEFAULT true,
    capacity           integer,
    -- informational reservation fee (party/clubhouse fee). Charging is NOT
    -- wired this migration — fee is captured + disclosed; settlement via the
    -- existing lease-fee/payment rails is a tracked follow-up.
    reservation_fee    numeric(10,2) NOT NULL DEFAULT 0,
    -- operating window a reservation must fall within (null = no constraint)
    open_time          time without time zone,
    close_time         time without time zone,
    -- cap on a single reservation's length (null = no cap)
    max_reservation_hours integer,
    -- how far ahead a resident may book (null = no limit)
    advance_booking_days  integer,
    active             boolean NOT NULL DEFAULT true,
    created_at         timestamp with time zone NOT NULL DEFAULT now(),
    updated_at         timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX common_areas_property_idx ON public.common_areas(property_id) WHERE active;
CREATE INDEX common_areas_landlord_idx ON public.common_areas(landlord_id);

-- ── common_area_reservations ──────────────────────────────────────────
CREATE TABLE public.common_area_reservations (
    id                 uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
    common_area_id     uuid NOT NULL REFERENCES public.common_areas(id) ON DELETE CASCADE,
    -- denormalized so the residents-fan-out + scoping queries don't re-join
    property_id        uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
    landlord_id        uuid NOT NULL REFERENCES public.landlords(id) ON DELETE CASCADE,
    -- the resident who booked it; NULL for landlord-created closures/rentals
    reserved_by_tenant_id uuid REFERENCES public.tenants(id) ON DELETE SET NULL,
    created_by_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE SET NULL,
    title              text,
    kind               text NOT NULL DEFAULT 'tenant_reservation',
    starts_at          timestamp with time zone NOT NULL,
    ends_at            timestamp with time zone NOT NULL,
    status             text NOT NULL DEFAULT 'pending',
    guest_count        integer,
    notes              text,
    fee_amount         numeric(10,2) NOT NULL DEFAULT 0,
    -- whether going-live should alert the property's residents. A resident's
    -- own private party defaults true (others need to know the area is taken);
    -- the landlord can suppress for a quiet/no-impact booking.
    notify_residents   boolean NOT NULL DEFAULT true,
    residents_notified_at timestamp with time zone,
    decided_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
    decided_at         timestamp with time zone,
    decision_note      text,
    created_at         timestamp with time zone NOT NULL DEFAULT now(),
    updated_at         timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT car_kind_check CHECK (kind = ANY (ARRAY[
        'tenant_reservation'::text, 'private_rental'::text,
        'maintenance_closure'::text, 'event'::text])),
    CONSTRAINT car_status_check CHECK (status = ANY (ARRAY[
        'pending'::text, 'approved'::text, 'rejected'::text, 'cancelled'::text])),
    CONSTRAINT car_time_order_check CHECK (ends_at > starts_at)
);
CREATE INDEX car_area_idx     ON public.common_area_reservations(common_area_id);
CREATE INDEX car_property_idx ON public.common_area_reservations(property_id);
CREATE INDEX car_tenant_idx   ON public.common_area_reservations(reserved_by_tenant_id);
-- overlap-conflict detection scans live (approved/pending) rows for an area
-- by time window; this index serves that hot path
CREATE INDEX car_area_window_idx ON public.common_area_reservations(common_area_id, starts_at, ends_at)
    WHERE status IN ('approved', 'pending');
