-- State landlord/tenant law knowledge base (compliance-warning engine).
--
-- ⚠ READ THIS BEFORE TOUCHING — this is a DELIBERATE, Nic-authorized (S442)
-- extension of the otherwise-load-bearing "no state-specific legal logic"
-- rule. The S18 purge removed AZ statute citations that were embedded in
-- PRODUCT COPY / LOGIC as advice. This is different and explicitly approved:
-- a SOURCED, DATED, DISCLAIMERED reference catalog that powers hedged
-- "this may not comply with the laws of <state>" WARNINGS for BOTH parties
-- (landlord + tenant). The citations live as DATA here (with a source URL +
-- the date the info was read from the official state site), never as
-- hard-coded legal assertions in code. Do NOT purge this as a no-state-legal
-- violation — it is the sanctioned carve-out, alongside
-- state_deposit_interest_rates (S188) and state_tax_forms (S203).
--
-- MODEL (Nic): per state there are multiple landlord/tenant ACTS, each
-- governing certain residential unit/tenancy types (AZ has ~4: residential,
-- mobile-home park, RV long-term space, etc.). Each act has PROVISIONS
-- (entry notice, deposit limits, late-fee rules, …) that the warning engine
-- compares a lease term / config / action against, surfacing a hedged
-- warning when it looks out of line.
--
-- SOURCING DISCIPLINE: read directly from official state sites; stamp every
-- row with source_url + source_date; QUARTERLY refresh (cut a new migration
-- per quarter — never UPDATE an existing row; insert new effective rows so
-- the dated history is preserved). Every surfaced warning carries the
-- source date + "this was current as of <date>; there may be newer
-- information — confirm with a local attorney."
--
-- SAFE — additive only: two new tables, no backfill, no changes to existing
-- tables. The framework ships empty; warnings fire only once verified rows
-- are seeded (Arizona first).

CREATE TABLE public.state_landlord_tenant_acts (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    state_code text NOT NULL,
    act_key text NOT NULL,               -- stable slug, e.g. 'residential', 'mobile_home_park'
    act_name text NOT NULL,              -- official act name
    unit_types text[] DEFAULT '{}'::text[] NOT NULL,  -- units.unit_type values this act governs
    official_url text,                   -- the official state source it was read from
    summary text,
    source_date date NOT NULL,           -- date the info was read from the source
    effective_year integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT slta_pkey PRIMARY KEY (id),
    CONSTRAINT slta_state_check CHECK (((state_code = upper(state_code)) AND (length(state_code) = 2))),
    CONSTRAINT slta_year_check CHECK (((effective_year >= 2020) AND (effective_year <= 2100))),
    CONSTRAINT slta_unique UNIQUE (state_code, act_key, effective_year)
);

CREATE TABLE public.state_law_provisions (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    act_id uuid NOT NULL,
    state_code text NOT NULL,            -- denormalized from the act for direct lookup
    topic text NOT NULL,                 -- e.g. 'entry_notice_hours', 'deposit_max_months'
    rule_kind text NOT NULL,             -- how the engine compares a value: min | max | required | info
    threshold_numeric numeric(12,2),     -- the comparison value (e.g. 48 hours, 2 months); NULL for info
    threshold_unit text,                 -- 'hours' | 'days' | 'months' | 'multiple_of_rent' | …
    summary text NOT NULL,               -- plain-language statement of the provision
    statute_citation text,               -- e.g. 'A.R.S. § 33-1343'
    source_url text,
    source_date date NOT NULL,
    effective_year integer NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT slp_pkey PRIMARY KEY (id),
    CONSTRAINT slp_act_fkey FOREIGN KEY (act_id) REFERENCES public.state_landlord_tenant_acts(id) ON DELETE CASCADE,
    CONSTRAINT slp_state_check CHECK (((state_code = upper(state_code)) AND (length(state_code) = 2))),
    CONSTRAINT slp_rule_kind_check CHECK ((rule_kind = ANY (ARRAY['min'::text, 'max'::text, 'required'::text, 'info'::text]))),
    CONSTRAINT slp_year_check CHECK (((effective_year >= 2020) AND (effective_year <= 2100)))
);

CREATE INDEX idx_slta_lookup ON public.state_landlord_tenant_acts (state_code, effective_year);
CREATE INDEX idx_slp_lookup ON public.state_law_provisions (state_code, topic, effective_year);
