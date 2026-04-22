-- S23d-infra: invitations, platform_events, role scope tables
-- Sessions A + B + C + D, April 2026
--
-- Creates the invitation lifecycle layer and the four role-specific
-- scope tables for landlord-assignable users (property_manager,
-- onsite_manager, maintenance, bookkeeper). See handoff notes for
-- the architecture rationale.
--
-- NOTE: A future migration will consolidate the four scope tables
-- into a single team_member_scopes table driven by permission flags
-- rather than per-role columns. These four tables are the current
-- source of truth and should be treated as such until that migration
-- lands.
--
-- Prerequisite: uuid-ossp extension (already present in base schema).

SET statement_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;

-- ---------- bookkeeper_scopes ----------
CREATE TABLE public.bookkeeper_scopes (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    user_id uuid NOT NULL,
    landlord_id uuid NOT NULL,
    access_level text DEFAULT 'read_only'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT bookkeeper_scopes_access_level_check
      CHECK ((access_level = ANY (ARRAY['read_only'::text, 'read_write'::text])))
);

ALTER TABLE ONLY public.bookkeeper_scopes
    ADD CONSTRAINT bookkeeper_scopes_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.bookkeeper_scopes
    ADD CONSTRAINT bookkeeper_scopes_user_id_landlord_id_key UNIQUE (user_id, landlord_id);
ALTER TABLE ONLY public.bookkeeper_scopes
    ADD CONSTRAINT bookkeeper_scopes_landlord_id_fkey
      FOREIGN KEY (landlord_id) REFERENCES public.landlords(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.bookkeeper_scopes
    ADD CONSTRAINT bookkeeper_scopes_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

CREATE INDEX idx_bookkeeper_scopes_landlord ON public.bookkeeper_scopes USING btree (landlord_id);
CREATE INDEX idx_bookkeeper_scopes_user     ON public.bookkeeper_scopes USING btree (user_id);

-- ---------- property_manager_scopes ----------
CREATE TABLE public.property_manager_scopes (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    user_id uuid NOT NULL,
    landlord_id uuid NOT NULL,
    property_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    unit_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    all_properties boolean DEFAULT false NOT NULL,
    maint_approval_ceiling_cents integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.property_manager_scopes
    ADD CONSTRAINT property_manager_scopes_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.property_manager_scopes
    ADD CONSTRAINT property_manager_scopes_user_id_landlord_id_key UNIQUE (user_id, landlord_id);
ALTER TABLE ONLY public.property_manager_scopes
    ADD CONSTRAINT property_manager_scopes_landlord_id_fkey
      FOREIGN KEY (landlord_id) REFERENCES public.landlords(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.property_manager_scopes
    ADD CONSTRAINT property_manager_scopes_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

CREATE INDEX idx_pm_scopes_landlord ON public.property_manager_scopes USING btree (landlord_id);
CREATE INDEX idx_pm_scopes_user     ON public.property_manager_scopes USING btree (user_id);

-- ---------- onsite_manager_scopes ----------
-- Uniqueness note: onsite_manager_scopes enforces UNIQUE (user_id) ALONE,
-- not (user_id, landlord_id), because the current model treats onsite
-- manager as a platform-wide single-landlord role. The upcoming
-- team_member_scopes rebuild will revisit whether this should be relaxed.
CREATE TABLE public.onsite_manager_scopes (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    user_id uuid NOT NULL,
    landlord_id uuid NOT NULL,
    property_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    unit_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.onsite_manager_scopes
    ADD CONSTRAINT onsite_manager_scopes_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.onsite_manager_scopes
    ADD CONSTRAINT onsite_manager_scopes_user_id_key UNIQUE (user_id);
ALTER TABLE ONLY public.onsite_manager_scopes
    ADD CONSTRAINT onsite_manager_scopes_landlord_id_fkey
      FOREIGN KEY (landlord_id) REFERENCES public.landlords(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.onsite_manager_scopes
    ADD CONSTRAINT onsite_manager_scopes_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

CREATE INDEX idx_onsite_scopes_landlord ON public.onsite_manager_scopes USING btree (landlord_id);

-- ---------- maintenance_worker_scopes ----------
CREATE TABLE public.maintenance_worker_scopes (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    user_id uuid NOT NULL,
    landlord_id uuid NOT NULL,
    property_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    unit_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    job_categories text[] DEFAULT '{}'::text[] NOT NULL,
    all_properties boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT maintenance_worker_scopes_job_categories_check
      CHECK ((job_categories <@ ARRAY['general'::text, 'plumbing'::text, 'electrical'::text,
                                      'hvac'::text, 'appliance'::text, 'landscape'::text,
                                      'pest'::text, 'cleaning'::text, 'roofing'::text,
                                      'structural'::text, 'pool'::text, 'locksmith'::text]))
);

ALTER TABLE ONLY public.maintenance_worker_scopes
    ADD CONSTRAINT maintenance_worker_scopes_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.maintenance_worker_scopes
    ADD CONSTRAINT maintenance_worker_scopes_user_id_landlord_id_key UNIQUE (user_id, landlord_id);
ALTER TABLE ONLY public.maintenance_worker_scopes
    ADD CONSTRAINT maintenance_worker_scopes_landlord_id_fkey
      FOREIGN KEY (landlord_id) REFERENCES public.landlords(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.maintenance_worker_scopes
    ADD CONSTRAINT maintenance_worker_scopes_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

CREATE INDEX idx_maint_scopes_landlord ON public.maintenance_worker_scopes USING btree (landlord_id);
CREATE INDEX idx_maint_scopes_user     ON public.maintenance_worker_scopes USING btree (user_id);

-- ---------- invitations ----------
CREATE TABLE public.invitations (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    email text NOT NULL,
    landlord_id uuid NOT NULL,
    role text NOT NULL,
    scope_payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    invited_by_user_id uuid NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    token text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    accepted_at timestamp with time zone,
    accepted_user_id uuid,
    revoked_at timestamp with time zone,
    revoked_by_user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT invitations_role_check
      CHECK ((role = ANY (ARRAY['property_manager'::text, 'onsite_manager'::text,
                                'maintenance'::text, 'bookkeeper'::text]))),
    CONSTRAINT invitations_status_check
      CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text,
                                  'expired'::text, 'revoked'::text])))
);

ALTER TABLE ONLY public.invitations
    ADD CONSTRAINT invitations_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.invitations
    ADD CONSTRAINT invitations_token_key UNIQUE (token);
ALTER TABLE ONLY public.invitations
    ADD CONSTRAINT invitations_accepted_user_id_fkey
      FOREIGN KEY (accepted_user_id) REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.invitations
    ADD CONSTRAINT invitations_invited_by_user_id_fkey
      FOREIGN KEY (invited_by_user_id) REFERENCES public.users(id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.invitations
    ADD CONSTRAINT invitations_landlord_id_fkey
      FOREIGN KEY (landlord_id) REFERENCES public.landlords(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.invitations
    ADD CONSTRAINT invitations_revoked_by_user_id_fkey
      FOREIGN KEY (revoked_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;

CREATE INDEX        idx_invitations_email    ON public.invitations USING btree (lower(email));
CREATE INDEX        idx_invitations_landlord ON public.invitations USING btree (landlord_id);
CREATE INDEX        idx_invitations_status   ON public.invitations USING btree (status) WHERE (status = 'pending'::text);
CREATE INDEX        idx_invitations_token    ON public.invitations USING btree (token);
-- Session D race-condition guard: one pending invite per (landlord, role, lowercased email).
-- Paired with the 23505 -> 409 translation in apps/api/src/routes/scopes.ts invite handler.
CREATE UNIQUE INDEX invitations_unique_pending
    ON public.invitations USING btree (landlord_id, role, lower(email))
    WHERE (status = 'pending'::text);

-- ---------- platform_events ----------
-- Platform-wide audit trail. Future reputation layer consumes this table --
-- do not treat it as a debug log. Keep CHECKs in lockstep with the shared
-- package constants INVITATION_EVENT_TYPES and PLATFORM_SUBJECT_TYPES.
CREATE TABLE public.platform_events (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    subject_type text NOT NULL,
    subject_id uuid NOT NULL,
    event_type text NOT NULL,
    actor_user_id uuid,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT platform_events_event_type_check
      CHECK ((event_type = ANY (ARRAY['invitation.created'::text, 'invitation.resent'::text,
                                      'invitation.viewed'::text,  'invitation.accepted'::text,
                                      'invitation.expired'::text, 'invitation.revoked'::text]))),
    CONSTRAINT platform_events_subject_type_check
      CHECK ((subject_type = 'invitation'::text))
);

ALTER TABLE ONLY public.platform_events
    ADD CONSTRAINT platform_events_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.platform_events
    ADD CONSTRAINT platform_events_actor_user_id_fkey
      FOREIGN KEY (actor_user_id) REFERENCES public.users(id) ON DELETE SET NULL;

CREATE INDEX idx_platform_events_actor   ON public.platform_events USING btree (actor_user_id);
CREATE INDEX idx_platform_events_created ON public.platform_events USING btree (created_at DESC);
CREATE INDEX idx_platform_events_subject ON public.platform_events USING btree (subject_type, subject_id);
CREATE INDEX idx_platform_events_type    ON public.platform_events USING btree (event_type);
