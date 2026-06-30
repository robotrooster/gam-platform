-- Service interruptions / utility outage broadcasts (launch feature, 2026-06-25)
--
-- WHY: when a utility goes down — water main repair, power shutoff for
-- electrical work, gas, elevator out, internet, etc. — every affected
-- resident needs to know it's happening AND when it's expected back. This
-- did not exist: maintenance "emergency" priority is inbound only (a tenant
-- reporting a problem pages the operators). This is the OUTBOUND direction:
-- a landlord posts a notice and it fans out to affected residents with an
-- expected-restore time. Planned (scheduled main repair) and emergency
-- (unplanned shutoff) are the same record — emergency just starts now and
-- carries urgent copy.
--
-- A notice targets a whole property (empty unit_ids) or a specific unit
-- subset (water main on one building only). expected_restore_at NULL means
-- "until further notice".
--
-- NO BACKFILL NEEDED — brand new table.

CREATE TABLE public.service_interruptions (
    id                  uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
    property_id         uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
    landlord_id         uuid NOT NULL REFERENCES public.landlords(id) ON DELETE CASCADE,
    -- empty array = whole property; otherwise the affected unit subset
    unit_ids            uuid[] NOT NULL DEFAULT '{}'::uuid[],
    utility_type        text NOT NULL,
    title               text,
    message             text,
    -- emergency = unplanned/immediate; drives urgent copy + SMS escalation
    is_emergency        boolean NOT NULL DEFAULT false,
    starts_at           timestamp with time zone NOT NULL,
    -- NULL = "until further notice"
    expected_restore_at timestamp with time zone,
    status              text NOT NULL DEFAULT 'scheduled',
    created_by_user_id  uuid NOT NULL REFERENCES public.users(id) ON DELETE SET NULL,
    residents_notified_at timestamp with time zone,
    resolved_at         timestamp with time zone,
    -- stamped if the landlord fires an all-clear when resolving
    restore_notified_at timestamp with time zone,
    created_at          timestamp with time zone NOT NULL DEFAULT now(),
    updated_at          timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT si_utility_type_check CHECK (utility_type = ANY (ARRAY[
        'water'::text, 'power'::text, 'gas'::text, 'heat_ac'::text,
        'elevator'::text, 'internet'::text, 'parking'::text, 'other'::text])),
    CONSTRAINT si_status_check CHECK (status = ANY (ARRAY[
        'scheduled'::text, 'active'::text, 'resolved'::text, 'cancelled'::text])),
    CONSTRAINT si_restore_order_check CHECK (
        expected_restore_at IS NULL OR expected_restore_at >= starts_at)
);
CREATE INDEX service_interruptions_property_idx ON public.service_interruptions(property_id);
CREATE INDEX service_interruptions_landlord_idx ON public.service_interruptions(landlord_id);
-- tenant banner hot path: live notices for a property
CREATE INDEX service_interruptions_live_idx ON public.service_interruptions(property_id, status)
    WHERE status IN ('scheduled', 'active');
