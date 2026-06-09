-- Full statutory TEXT corpus for the S442 state-law KB — so the agent can
-- answer OBSCURE questions accurately by retrieving the actual section text,
-- not just the handful of structured provisions in state_law_provisions.
--
-- Stores every section of each landlord/tenant act verbatim, with a Postgres
-- full-text index (GIN over a generated tsvector) so a natural-language
-- question can be matched to the relevant statute section in-database — no
-- embedding-server dependency (a vector column can be layered on later for
-- semantic search). Same sourcing discipline as the rest of the KB: every
-- row carries source_url + source_date; anything surfaced gets the dated
-- "may be newer info; not legal advice; confirm with a local attorney"
-- disclaimer. Part of the Nic-authorized carve-out — do NOT purge.
--
-- SAFE: additive, no backfill. Ships empty; sections are ingested per act.
-- Quarterly refresh = insert new effective_year rows, never UPDATE.

CREATE TABLE public.state_law_section_texts (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    state_code text NOT NULL,
    act_key text NOT NULL,               -- matches state_landlord_tenant_acts.act_key
    section_number text NOT NULL,        -- e.g. '33-1343'
    section_title text,
    full_text text NOT NULL,
    source_url text,
    source_date date NOT NULL,
    effective_year integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    search_tsv tsvector GENERATED ALWAYS AS (
      to_tsvector('english', coalesce(section_title, '') || ' ' || coalesce(full_text, ''))
    ) STORED,
    CONSTRAINT slst_pkey PRIMARY KEY (id),
    CONSTRAINT slst_state_check CHECK (((state_code = upper(state_code)) AND (length(state_code) = 2))),
    CONSTRAINT slst_year_check CHECK (((effective_year >= 2020) AND (effective_year <= 2100))),
    CONSTRAINT slst_unique UNIQUE (state_code, act_key, section_number, effective_year)
);

CREATE INDEX idx_slst_search ON public.state_law_section_texts USING GIN (search_tsv);
CREATE INDEX idx_slst_lookup ON public.state_law_section_texts (state_code, act_key);
