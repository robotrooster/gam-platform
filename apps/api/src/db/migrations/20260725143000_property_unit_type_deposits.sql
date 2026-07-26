-- S556 (Nic): per-(property, unit_type) security-deposit MULTIPLIER.
--
-- WHY: a lease's security deposit is a DERIVED value, not a flat number the
-- landlord retypes each time — deposit = rent_amount × multiplier (e.g. 1.5 =
-- a month-and-a-half deposit). The unit stores market rent; the deposit falls
-- out of it. This mirrors the per-(property, unit_type) shape of
-- property_unit_type_late_fees so the same "the unit's type resolves the
-- policy" model applies (an RV spot and an apartment can carry different
-- deposit norms at the same property).
--
-- Used by lease-document creation (esign createDocumentRecord) to seed the
-- security_deposit box from the assigned unit's rent. No row = default 1.0
-- (deposit == one month's rent). Renewals do NOT auto-raise the deposit — a
-- rent increase surfaces a landlord-confirmed top-up suggestion, not a silent
-- change (see the lease-autopopulate memory / renewal flow).
--
-- No backfill needed: absence of a row means multiplier 1.0.

CREATE TABLE public.property_unit_type_deposits (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    property_id uuid NOT NULL,
    unit_type text NOT NULL,
    deposit_multiplier numeric(5,2) NOT NULL DEFAULT 1.0,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT property_unit_type_deposits_pkey PRIMARY KEY (id),
    CONSTRAINT property_unit_type_deposits_property_id_fkey
        FOREIGN KEY (property_id) REFERENCES public.properties(id) ON DELETE CASCADE,
    CONSTRAINT property_unit_type_deposits_multiplier_check
        CHECK ((deposit_multiplier >= (0)::numeric) AND (deposit_multiplier <= (12)::numeric)),
    CONSTRAINT property_unit_type_deposits_unit_type_check
        CHECK ((unit_type = ANY (ARRAY['apartment'::text, 'single_family'::text, 'rv_spot'::text, 'mobile_home'::text, 'hotel_room'::text, 'storage'::text, 'commercial'::text]))),
    CONSTRAINT property_unit_type_deposits_uniq UNIQUE (property_id, unit_type)
);
