--
-- PostgreSQL database dump
--


-- Dumped from database version 16.13 (Homebrew)
-- Dumped by pg_dump version 16.13 (Homebrew)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: uuid-ossp; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;


--
-- Name: fn_invoice_late_fee_subtotal_rollup_single(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fn_invoice_late_fee_subtotal_rollup_single(p_invoice_id integer) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE invoices
  SET subtotal_late_fees = COALESCE((
    SELECT SUM(amount)
    FROM payments
    WHERE invoice_id = p_invoice_id
      AND type = 'late_fee'
      AND status IN ('pending', 'processing', 'settled')
  ), 0)
  WHERE id = p_invoice_id;
END;
$$;


--
-- Name: fn_invoice_late_fee_subtotal_rollup_trigger(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fn_invoice_late_fee_subtotal_rollup_trigger() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.type = 'late_fee' AND NEW.invoice_id IS NOT NULL THEN
      PERFORM fn_invoice_late_fee_subtotal_rollup_single(NEW.invoice_id);
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.type = 'late_fee' AND OLD.invoice_id IS NOT NULL THEN
      PERFORM fn_invoice_late_fee_subtotal_rollup_single(OLD.invoice_id);
    END IF;
    IF NEW.type = 'late_fee' AND NEW.invoice_id IS NOT NULL
       AND (OLD.type IS DISTINCT FROM 'late_fee'
            OR OLD.invoice_id IS DISTINCT FROM NEW.invoice_id) THEN
      PERFORM fn_invoice_late_fee_subtotal_rollup_single(NEW.invoice_id);
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.type = 'late_fee' AND OLD.invoice_id IS NOT NULL THEN
      PERFORM fn_invoice_late_fee_subtotal_rollup_single(OLD.invoice_id);
    END IF;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;


--
-- Name: fn_invoice_status_rollup(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fn_invoice_status_rollup() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF (TG_OP = 'DELETE') THEN
    IF OLD.invoice_id IS NOT NULL THEN
      PERFORM fn_invoice_status_rollup_single(OLD.invoice_id);
    END IF;
    RETURN OLD;
  END IF;

  IF (TG_OP = 'UPDATE' AND OLD.invoice_id IS DISTINCT FROM NEW.invoice_id
      AND OLD.invoice_id IS NOT NULL) THEN
    PERFORM fn_invoice_status_rollup_single(OLD.invoice_id);
  END IF;

  IF NEW.invoice_id IS NOT NULL THEN
    PERFORM fn_invoice_status_rollup_single(NEW.invoice_id);
  END IF;

  RETURN NEW;
END;
$$;


--
-- Name: fn_invoice_status_rollup_single(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fn_invoice_status_rollup_single(p_invoice_id uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_total_children   INTEGER;
  v_settled_children INTEGER;
  v_current_status   TEXT;
  v_new_status       TEXT;
BEGIN
  SELECT status INTO v_current_status FROM invoices WHERE id = p_invoice_id;
  IF v_current_status = 'void' THEN
    RETURN;
  END IF;

  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE status = 'settled')
  INTO v_total_children, v_settled_children
  FROM payments
  WHERE invoice_id = p_invoice_id;

  IF v_total_children = 0 THEN
    v_new_status := 'pending';
  ELSIF v_settled_children = 0 THEN
    v_new_status := 'pending';
  ELSIF v_settled_children = v_total_children THEN
    v_new_status := 'settled';
  ELSE
    v_new_status := 'partial';
  END IF;

  IF v_new_status IS DISTINCT FROM v_current_status THEN
    UPDATE invoices
    SET status = v_new_status, updated_at = now()
    WHERE id = p_invoice_id;
  END IF;
END;
$$;


--
-- Name: fn_invoices_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fn_invoices_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;


--
-- Name: update_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: ach_monitoring_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ach_monitoring_log (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    payment_id uuid,
    event_type text NOT NULL,
    tenant_id uuid,
    bank_fingerprint text,
    amount numeric(10,2),
    return_code text,
    flagged boolean DEFAULT false,
    resolved boolean DEFAULT false,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT ach_monitoring_log_event_type_check CHECK ((event_type = ANY (ARRAY['first_sender'::text, 'velocity_flag'::text, 'return_received'::text, 'zero_tolerance_block'::text])))
);


--
-- Name: audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_log (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    user_id uuid,
    action text NOT NULL,
    entity_type text,
    entity_id uuid,
    old_value jsonb,
    new_value jsonb,
    ip_address text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: background_checks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.background_checks (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    unit_id uuid,
    landlord_id uuid NOT NULL,
    applicant_name text NOT NULL,
    applicant_email text NOT NULL,
    amount_charged numeric(10,2) DEFAULT 40.00,
    platform_net numeric(10,2) DEFAULT 15.00,
    provider_ref text,
    status text DEFAULT 'pending'::text,
    result_url text,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT background_checks_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'complete'::text, 'failed'::text])))
);


--
-- Name: bank_reconciliations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bank_reconciliations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    landlord_id uuid,
    account_id uuid,
    period_start date NOT NULL,
    period_end date NOT NULL,
    statement_balance numeric(12,2) NOT NULL,
    book_balance numeric(12,2) NOT NULL,
    difference numeric(12,2) GENERATED ALWAYS AS ((statement_balance - book_balance)) STORED,
    status character varying(20) DEFAULT 'open'::character varying,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: bookkeeper_scopes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bookkeeper_scopes (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    user_id uuid NOT NULL,
    landlord_id uuid NOT NULL,
    access_level text DEFAULT 'read_only'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT bookkeeper_scopes_access_level_check CHECK ((access_level = ANY (ARRAY['read_only'::text, 'read_write'::text])))
);


--
-- Name: books_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.books_accounts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    landlord_id uuid,
    code character varying(20) NOT NULL,
    name character varying(200) NOT NULL,
    type character varying(50) NOT NULL,
    subtype character varying(50),
    description text,
    is_system boolean DEFAULT false,
    balance numeric(12,2) DEFAULT 0,
    active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: books_bills; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.books_bills (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    landlord_id uuid,
    vendor_id uuid,
    bill_number character varying(100),
    date date NOT NULL,
    due_date date,
    description text NOT NULL,
    amount numeric(12,2) NOT NULL,
    amount_paid numeric(12,2) DEFAULT 0,
    status character varying(20) DEFAULT 'open'::character varying,
    category character varying(100),
    account_id uuid,
    notes text,
    paid_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: books_contractors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.books_contractors (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    landlord_id uuid,
    first_name character varying(100),
    last_name character varying(100),
    business_name character varying(200),
    email character varying(200),
    phone character varying(20),
    address text,
    ein character varying(10),
    ssn_last4 character varying(4),
    entity_type character varying(30) DEFAULT 'individual'::character varying,
    trade character varying(100),
    pay_rate numeric(10,2),
    pay_unit character varying(20) DEFAULT 'project'::character varying,
    status character varying(20) DEFAULT 'active'::character varying,
    ytd_paid numeric(12,2) DEFAULT 0,
    w9_on_file boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: books_employees; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.books_employees (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    landlord_id uuid,
    first_name character varying(100) NOT NULL,
    last_name character varying(100) NOT NULL,
    email character varying(200),
    phone character varying(20),
    address text,
    ssn_last4 character varying(4),
    pay_type character varying(20) DEFAULT 'salary'::character varying NOT NULL,
    pay_rate numeric(10,2) DEFAULT 0 NOT NULL,
    pay_frequency character varying(20) DEFAULT 'biweekly'::character varying,
    filing_status character varying(20) DEFAULT 'single'::character varying,
    federal_allowances integer DEFAULT 0,
    az_withholding_pct numeric(5,2) DEFAULT 2.5,
    title character varying(100),
    department character varying(100),
    start_date date,
    end_date date,
    status character varying(20) DEFAULT 'active'::character varying,
    ytd_gross numeric(12,2) DEFAULT 0,
    ytd_federal_tax numeric(12,2) DEFAULT 0,
    ytd_state_tax numeric(12,2) DEFAULT 0,
    ytd_ss numeric(12,2) DEFAULT 0,
    ytd_medicare numeric(12,2) DEFAULT 0,
    ytd_net numeric(12,2) DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: books_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.books_transactions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    landlord_id uuid,
    date date NOT NULL,
    description text NOT NULL,
    amount numeric(12,2) NOT NULL,
    type character varying(20) NOT NULL,
    category character varying(100),
    account_id uuid,
    reference text,
    reconciled boolean DEFAULT false,
    reconciled_at timestamp with time zone,
    source character varying(30) DEFAULT 'manual'::character varying,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: books_vendors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.books_vendors (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    landlord_id uuid,
    name character varying(200) NOT NULL,
    contact_name character varying(200),
    email character varying(200),
    phone character varying(20),
    address text,
    category character varying(100),
    payment_terms character varying(50) DEFAULT 'net30'::character varying,
    account_number character varying(100),
    tax_id character varying(20),
    ap_balance numeric(12,2) DEFAULT 0,
    ytd_paid numeric(12,2) DEFAULT 0,
    status character varying(20) DEFAULT 'active'::character varying,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: bulletin_posts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bulletin_posts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid,
    property_id uuid,
    city text,
    state text,
    scope text DEFAULT 'property'::text,
    content text NOT NULL,
    alias text,
    upvote_count integer DEFAULT 0,
    flag_count integer DEFAULT 0,
    total_votes integer DEFAULT 0,
    pinned boolean DEFAULT false,
    is_removed boolean DEFAULT false,
    removed_at timestamp with time zone,
    removed_by uuid,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: bulletin_reveal_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bulletin_reveal_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    post_id uuid,
    revealed_by text,
    admin_id uuid,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: bulletin_votes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bulletin_votes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    post_id uuid,
    tenant_id uuid,
    vote_type text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: contractors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contractors (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name text NOT NULL,
    business_name text NOT NULL,
    phone text NOT NULL,
    email text NOT NULL,
    azroc_license text NOT NULL,
    insurance_verified boolean DEFAULT false,
    insurance_expiry date,
    listing_tier text,
    listing_fee numeric(10,2),
    trades text[] DEFAULT '{}'::text[],
    rating numeric(3,2),
    completed_jobs integer DEFAULT 0,
    active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT contractors_listing_tier_check CHECK ((listing_tier = ANY (ARRAY['featured'::text, 'premium'::text, 'exclusive'::text])))
);


--
-- Name: disbursements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.disbursements (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    landlord_id uuid NOT NULL,
    amount numeric(10,2) NOT NULL,
    unit_count integer NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    stripe_payout_id text,
    from_reserve boolean DEFAULT false,
    reserve_amount numeric(10,2) DEFAULT 0,
    target_date date NOT NULL,
    initiated_at timestamp with time zone,
    settled_at timestamp with time zone,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT disbursements_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'settled'::text, 'failed'::text])))
);


--
-- Name: document_batches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_batches (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    landlord_id uuid NOT NULL,
    title text NOT NULL,
    template_id uuid NOT NULL,
    scope_type text NOT NULL,
    scope_ref jsonb,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    voided_at timestamp with time zone,
    voided_by uuid,
    CONSTRAINT document_batches_scope_type_check CHECK ((scope_type = ANY (ARRAY['units'::text, 'property'::text, 'landlord_all'::text]))),
    CONSTRAINT document_batches_status_check CHECK ((status = ANY (ARRAY['active'::text, 'voided'::text])))
);


--
-- Name: documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.documents (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    lease_id uuid,
    unit_id uuid,
    tenant_id uuid,
    landlord_id uuid NOT NULL,
    type text NOT NULL,
    name text NOT NULL,
    url text NOT NULL,
    file_size integer,
    mime_type text,
    signed_by_tenant boolean DEFAULT false,
    signed_by_landlord boolean DEFAULT false,
    signed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT documents_type_check CHECK ((type = ANY (ARRAY['lease'::text, 'addendum'::text, 'move_in_checklist'::text, 'move_out_checklist'::text, 'notice'::text, 'other'::text])))
);


--
-- Name: emergency_contacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.emergency_contacts (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    tenant_id uuid NOT NULL,
    name text NOT NULL,
    phone text,
    email text,
    relationship text,
    notes text,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: fitness_body_weight_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fitness_body_weight_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    weight_lbs numeric(6,2) NOT NULL,
    logged_date date DEFAULT CURRENT_DATE NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: fitness_days; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fitness_days (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    routine_id uuid NOT NULL,
    day_number integer NOT NULL,
    title text NOT NULL,
    subtitle text,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: fitness_exercises; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fitness_exercises (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    section_id uuid NOT NULL,
    name text NOT NULL,
    sets integer,
    reps_min integer,
    reps_max integer,
    notes text,
    sort_order integer DEFAULT 0 NOT NULL
);


--
-- Name: fitness_milestones; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fitness_milestones (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    milestone_type text NOT NULL,
    achieved_at timestamp with time zone DEFAULT now(),
    total_lbs_at_achievement numeric(16,2)
);


--
-- Name: fitness_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fitness_profiles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    height_inches integer,
    weight_lbs numeric(6,2),
    age integer,
    goal_physique text,
    target_weight_lbs numeric(6,2),
    experience_level text,
    injuries text[],
    available_equipment text[],
    days_per_week integer,
    minutes_per_session integer,
    fitness_goal text,
    onboarding_complete boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT fitness_profiles_experience_level_check CHECK ((experience_level = ANY (ARRAY['beginner'::text, 'intermediate'::text, 'advanced'::text]))),
    CONSTRAINT fitness_profiles_fitness_goal_check CHECK ((fitness_goal = ANY (ARRAY['recomp'::text, 'bulk'::text, 'cut'::text, 'athletic'::text])))
);


--
-- Name: fitness_routines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fitness_routines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    is_active boolean DEFAULT true,
    is_preset boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: fitness_sections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fitness_sections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    day_id uuid NOT NULL,
    label text NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL
);


--
-- Name: fitness_set_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fitness_set_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    log_id uuid NOT NULL,
    user_id uuid NOT NULL,
    exercise_id uuid,
    exercise_name text NOT NULL,
    weight_lbs numeric(8,2) DEFAULT 0,
    reps integer DEFAULT 0 NOT NULL,
    is_counted boolean DEFAULT false,
    logged_at timestamp with time zone DEFAULT now()
);


--
-- Name: fitness_workout_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fitness_workout_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    day_id uuid,
    day_title text,
    logged_date date DEFAULT CURRENT_DATE NOT NULL,
    completed_at timestamp with time zone,
    duration_minutes integer,
    notes text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: float_account_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.float_account_state (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    balance numeric(10,2) DEFAULT 25000 NOT NULL,
    seed_capital numeric(10,2) DEFAULT 25000 NOT NULL,
    apy numeric(5,4) DEFAULT 0.045 NOT NULL,
    monthly_interest numeric(10,2) DEFAULT 0,
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: invitations; Type: TABLE; Schema: public; Owner: -
--

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
    CONSTRAINT invitations_role_check CHECK ((role = ANY (ARRAY['property_manager'::text, 'onsite_manager'::text, 'maintenance'::text, 'bookkeeper'::text]))),
    CONSTRAINT invitations_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'expired'::text, 'revoked'::text])))
);


--
-- Name: invoice_sequences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invoice_sequences (
    landlord_id uuid NOT NULL,
    year integer NOT NULL,
    next_number integer DEFAULT 1 NOT NULL
);


--
-- Name: invoices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invoices (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    landlord_id uuid NOT NULL,
    tenant_id uuid,
    lease_id uuid NOT NULL,
    unit_id uuid NOT NULL,
    invoice_number text NOT NULL,
    due_date date NOT NULL,
    subtotal_rent numeric(12,2) DEFAULT 0 NOT NULL,
    subtotal_fees numeric(12,2) DEFAULT 0 NOT NULL,
    subtotal_utilities numeric(12,2) DEFAULT 0 NOT NULL,
    subtotal_deposits numeric(12,2) DEFAULT 0 NOT NULL,
    subtotal_late_fees numeric(12,2) DEFAULT 0 NOT NULL,
    total_amount numeric(12,2) NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    sent_at timestamp with time zone,
    viewed_at timestamp with time zone,
    pdf_url text,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT invoices_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'partial'::text, 'settled'::text, 'void'::text]))),
    CONSTRAINT invoices_subtotal_deposits_check CHECK ((subtotal_deposits >= (0)::numeric)),
    CONSTRAINT invoices_subtotal_fees_check CHECK ((subtotal_fees >= (0)::numeric)),
    CONSTRAINT invoices_subtotal_late_fees_check CHECK ((subtotal_late_fees >= (0)::numeric)),
    CONSTRAINT invoices_subtotal_rent_check CHECK ((subtotal_rent >= (0)::numeric)),
    CONSTRAINT invoices_subtotal_utilities_check CHECK ((subtotal_utilities >= (0)::numeric)),
    CONSTRAINT invoices_total_amount_check CHECK ((total_amount >= (0)::numeric))
);


--
-- Name: journal_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.journal_entries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    landlord_id uuid,
    entry_number integer NOT NULL,
    date date NOT NULL,
    description text NOT NULL,
    reference text,
    type character varying(30) DEFAULT 'manual'::character varying,
    status character varying(20) DEFAULT 'posted'::character varying,
    total_debits numeric(12,2) DEFAULT 0,
    total_credits numeric(12,2) DEFAULT 0,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: journal_entries_entry_number_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.journal_entries_entry_number_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: journal_entries_entry_number_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.journal_entries_entry_number_seq OWNED BY public.journal_entries.entry_number;


--
-- Name: journal_entry_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.journal_entry_lines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    entry_id uuid NOT NULL,
    account_id uuid NOT NULL,
    description text,
    debit numeric(12,2) DEFAULT 0 NOT NULL,
    credit numeric(12,2) DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: landlords; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.landlords (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    user_id uuid NOT NULL,
    business_name text,
    ein text,
    stripe_account_id text,
    stripe_bank_verified boolean DEFAULT false,
    onboarding_complete boolean DEFAULT false,
    volume_tier text DEFAULT 'standard'::text,
    annual_contract boolean DEFAULT false,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    bg_check_fee numeric(10,2),
    bg_check_fee_min numeric(10,2),
    maint_approval_threshold numeric(10,2) DEFAULT 500 NOT NULL,
    theme_accent text,
    font_style text,
    agreement_signed_at timestamp with time zone,
    agreement_signature text,
    management_type text,
    CONSTRAINT landlords_volume_tier_check CHECK ((volume_tier = ANY (ARRAY['standard'::text, 'growth'::text, 'professional'::text, 'enterprise'::text, 'partner'::text])))
);


--
-- Name: lease_document_fields; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lease_document_fields (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    document_id uuid NOT NULL,
    template_field_id uuid,
    signer_id uuid,
    field_type text NOT NULL,
    signer_role text,
    label text,
    lease_column text,
    page integer DEFAULT 1,
    x double precision,
    y double precision,
    width double precision,
    height double precision,
    required boolean DEFAULT true,
    value text,
    font_css text,
    signed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT lease_document_fields_lease_column_check CHECK (((lease_column IS NULL) OR (lease_column = ANY (ARRAY['tenant_name'::text, 'tenant_email'::text, 'landlord_name'::text, 'unit_number'::text, 'property_name'::text, 'property_address'::text, 'tenant_signature'::text, 'landlord_signature'::text, 'tenant_initial'::text, 'landlord_initial'::text, 'date_signed'::text, 'rent_amount'::text, 'start_date'::text, 'end_date'::text, 'security_deposit'::text, 'rent_due_day'::text, 'lease_type'::text, 'auto_renew'::text, 'auto_renew_mode'::text, 'notice_days_required'::text, 'expiration_notice_days'::text, 'late_fee_grace_days'::text, 'late_fee_initial_flat'::text, 'late_fee_initial_percent'::text, 'late_fee_accrual_flat_daily'::text, 'late_fee_accrual_flat_weekly'::text, 'late_fee_accrual_flat_monthly'::text, 'late_fee_accrual_percent_daily'::text, 'late_fee_accrual_percent_weekly'::text, 'late_fee_accrual_percent_monthly'::text, 'late_fee_cap_flat'::text, 'late_fee_cap_percent'::text, 'pet_deposit'::text, 'key_deposit'::text, 'cleaning_deposit'::text, 'move_in_fee'::text, 'cleaning_fee'::text, 'pet_fee'::text, 'application_fee'::text, 'amenity_fee'::text, 'hoa_transfer_fee'::text, 'lease_prep_fee'::text, 'pet_rent'::text, 'parking_rent'::text, 'storage_rent'::text, 'amenity_fee_monthly'::text, 'trash_fee'::text, 'pest_control_fee'::text, 'technology_fee'::text, 'last_month_rent'::text, 'early_termination_fee'::text, 'other_fee'::text, 'utility_water_responsibility'::text, 'utility_gas_responsibility'::text, 'utility_electric_responsibility'::text, 'utility_sewer_responsibility'::text, 'utility_trash_responsibility'::text, 'custom_text'::text]))))
);


--
-- Name: lease_document_signers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lease_document_signers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    document_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    phone text,
    order_index integer DEFAULT 1 NOT NULL,
    token text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    invite_sent boolean DEFAULT false,
    viewed_at timestamp with time zone,
    signed_at timestamp with time zone,
    signature_data text,
    ip_address text,
    user_agent text,
    created_at timestamp with time zone DEFAULT now(),
    invite_sent_at timestamp with time zone,
    reminder_sent_at timestamp with time zone,
    CONSTRAINT lease_document_signers_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'sent'::text, 'viewed'::text, 'signed'::text, 'declined'::text])))
);


--
-- Name: lease_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lease_documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    template_id uuid,
    landlord_id uuid NOT NULL,
    unit_id uuid,
    lease_id uuid,
    title text NOT NULL,
    base_pdf_url text,
    executed_pdf_url text,
    status text DEFAULT 'pending'::text NOT NULL,
    page_count integer DEFAULT 1,
    sent_at timestamp with time zone,
    completed_at timestamp with time zone,
    voided_at timestamp with time zone,
    void_reason text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    document_type text DEFAULT 'original_lease'::text NOT NULL,
    target_lease_tenant_id uuid,
    promote_lease_tenant_id uuid,
    batch_id uuid,
    execution_failed_at timestamp with time zone,
    CONSTRAINT lease_documents_addendum_fields_check CHECK ((((document_type = 'addendum_remove'::text) AND (target_lease_tenant_id IS NOT NULL)) OR ((document_type = ANY (ARRAY['original_lease'::text, 'addendum_add'::text, 'addendum_terms'::text])) AND (target_lease_tenant_id IS NULL) AND (promote_lease_tenant_id IS NULL)))),
    CONSTRAINT lease_documents_document_type_check CHECK ((document_type = ANY (ARRAY['original_lease'::text, 'addendum_add'::text, 'addendum_remove'::text, 'addendum_terms'::text]))),
    CONSTRAINT lease_documents_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'sent'::text, 'in_progress'::text, 'completed'::text, 'voided'::text, 'execution_failed'::text])))
);


--
-- Name: lease_fees; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lease_fees (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    lease_id uuid NOT NULL,
    fee_type text NOT NULL,
    amount numeric NOT NULL,
    is_refundable boolean NOT NULL,
    due_timing text NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT lease_fees_amount_check CHECK ((amount >= (0)::numeric)),
    CONSTRAINT lease_fees_due_timing_check CHECK ((due_timing = ANY (ARRAY['move_in'::text, 'monthly_ongoing'::text, 'move_out'::text, 'other'::text]))),
    CONSTRAINT lease_fees_fee_type_check CHECK ((fee_type = ANY (ARRAY['pet_deposit'::text, 'key_deposit'::text, 'cleaning_deposit'::text, 'move_in_fee'::text, 'cleaning_fee'::text, 'pet_fee'::text, 'application_fee'::text, 'amenity_fee'::text, 'hoa_transfer_fee'::text, 'lease_prep_fee'::text, 'pet_rent'::text, 'parking_rent'::text, 'storage_rent'::text, 'amenity_fee_monthly'::text, 'trash_fee'::text, 'pest_control_fee'::text, 'technology_fee'::text, 'last_month_rent'::text, 'early_termination_fee'::text, 'other_fee'::text])))
);


--
-- Name: lease_occupants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lease_occupants (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    lease_id uuid NOT NULL,
    full_name text NOT NULL,
    relationship_to_primary_tenant text,
    date_of_birth date,
    is_minor boolean DEFAULT false NOT NULL,
    requires_background_check boolean DEFAULT false NOT NULL,
    background_check_id uuid,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: lease_pets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lease_pets (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    lease_id uuid NOT NULL,
    name text,
    species text NOT NULL,
    breed text,
    color text,
    age_years numeric(4,1),
    weight_lbs numeric(6,1),
    is_service_animal boolean DEFAULT false NOT NULL,
    is_emotional_support boolean DEFAULT false NOT NULL,
    service_animal_documentation_url text,
    license_county text,
    license_number text,
    vaccinations_current boolean,
    vet_name text,
    vet_phone text,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT lease_pets_species_check CHECK ((species = ANY (ARRAY['dog'::text, 'cat'::text, 'bird'::text, 'reptile'::text, 'fish'::text, 'small_mammal'::text, 'livestock'::text, 'other'::text])))
);


--
-- Name: lease_template_fields; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lease_template_fields (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    template_id uuid NOT NULL,
    field_type text NOT NULL,
    signer_role text,
    label text,
    lease_column text,
    page integer DEFAULT 1,
    x double precision,
    y double precision,
    width double precision DEFAULT 200,
    height double precision DEFAULT 50,
    required boolean DEFAULT true,
    sort_order integer DEFAULT 0,
    font_css text,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT lease_template_fields_lease_column_check CHECK (((lease_column IS NULL) OR (lease_column = ANY (ARRAY['tenant_name'::text, 'tenant_email'::text, 'landlord_name'::text, 'unit_number'::text, 'property_name'::text, 'property_address'::text, 'tenant_signature'::text, 'landlord_signature'::text, 'tenant_initial'::text, 'landlord_initial'::text, 'date_signed'::text, 'rent_amount'::text, 'start_date'::text, 'end_date'::text, 'security_deposit'::text, 'rent_due_day'::text, 'lease_type'::text, 'auto_renew'::text, 'auto_renew_mode'::text, 'notice_days_required'::text, 'expiration_notice_days'::text, 'late_fee_grace_days'::text, 'late_fee_initial_flat'::text, 'late_fee_initial_percent'::text, 'late_fee_accrual_flat_daily'::text, 'late_fee_accrual_flat_weekly'::text, 'late_fee_accrual_flat_monthly'::text, 'late_fee_accrual_percent_daily'::text, 'late_fee_accrual_percent_weekly'::text, 'late_fee_accrual_percent_monthly'::text, 'late_fee_cap_flat'::text, 'late_fee_cap_percent'::text, 'pet_deposit'::text, 'key_deposit'::text, 'cleaning_deposit'::text, 'move_in_fee'::text, 'cleaning_fee'::text, 'pet_fee'::text, 'application_fee'::text, 'amenity_fee'::text, 'hoa_transfer_fee'::text, 'lease_prep_fee'::text, 'pet_rent'::text, 'parking_rent'::text, 'storage_rent'::text, 'amenity_fee_monthly'::text, 'trash_fee'::text, 'pest_control_fee'::text, 'technology_fee'::text, 'last_month_rent'::text, 'early_termination_fee'::text, 'other_fee'::text, 'utility_water_responsibility'::text, 'utility_gas_responsibility'::text, 'utility_electric_responsibility'::text, 'utility_sewer_responsibility'::text, 'utility_trash_responsibility'::text, 'custom_text'::text]))))
);


--
-- Name: lease_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lease_templates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    landlord_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    base_pdf_url text,
    page_count integer DEFAULT 1,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: lease_tenants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lease_tenants (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    lease_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    role text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    added_at timestamp with time zone,
    removed_at timestamp with time zone,
    added_reason text,
    removed_reason text,
    financial_responsibility text DEFAULT 'joint_several'::text NOT NULL,
    responsibility_pct numeric(5,2),
    add_document_id uuid,
    remove_document_id uuid,
    supersedes_lease_tenant_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT lease_tenants_added_reason_check CHECK (((added_reason IS NULL) OR (added_reason = ANY (ARRAY['original'::text, 'roommate_added'::text, 'replacement'::text])))),
    CONSTRAINT lease_tenants_financial_responsibility_check CHECK ((financial_responsibility = ANY (ARRAY['joint_several'::text, 'split_equal'::text, 'split_custom'::text]))),
    CONSTRAINT lease_tenants_removed_reason_check CHECK (((removed_reason IS NULL) OR (removed_reason = ANY (ARRAY['moved_out'::text, 'replaced'::text, 'lease_ended'::text])))),
    CONSTRAINT lease_tenants_role_check CHECK ((role = ANY (ARRAY['primary'::text, 'co_tenant'::text]))),
    CONSTRAINT lease_tenants_status_check CHECK ((status = ANY (ARRAY['pending_add'::text, 'active'::text, 'pending_remove'::text, 'removed'::text, 'void'::text])))
);


--
-- Name: lease_utility_assignments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lease_utility_assignments (
    lease_id uuid NOT NULL,
    meter_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: lease_utility_responsibilities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lease_utility_responsibilities (
    lease_id uuid NOT NULL,
    utility_type text NOT NULL,
    tenant_responsible boolean NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT lease_utility_responsibilities_utility_type_check CHECK ((utility_type = ANY (ARRAY['water'::text, 'gas'::text, 'electric'::text, 'sewer'::text, 'trash'::text])))
);


--
-- Name: lease_vehicles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lease_vehicles (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    lease_id uuid NOT NULL,
    owner_tenant_id uuid,
    vehicle_type text NOT NULL,
    year integer,
    make text,
    model text,
    color text,
    license_plate text,
    plate_state text,
    registration_expiry date,
    parking_spot_assignment text,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT lease_vehicles_vehicle_type_check CHECK ((vehicle_type = ANY (ARRAY['car'::text, 'truck'::text, 'suv'::text, 'van'::text, 'motorcycle'::text, 'scooter'::text, 'utility_trailer'::text, 'boat'::text, 'other'::text])))
);


--
-- Name: leases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.leases (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    unit_id uuid NOT NULL,
    landlord_id uuid NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    start_date date NOT NULL,
    end_date date,
    rent_amount numeric(10,2) NOT NULL,
    rent_due_day integer DEFAULT 1 NOT NULL,
    security_deposit numeric(10,2) DEFAULT 0 NOT NULL,
    late_fee_grace_days integer DEFAULT 5,
    late_fee_initial_amount numeric(10,2) DEFAULT 15.00,
    signed_by_landlord boolean DEFAULT false,
    signed_by_tenant boolean DEFAULT false,
    signed_at timestamp with time zone,
    terminated_at timestamp with time zone,
    termination_reason text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    lease_type text NOT NULL,
    auto_renew boolean DEFAULT false NOT NULL,
    auto_renew_mode text,
    notice_days_required integer DEFAULT 30 NOT NULL,
    expiration_notice_days integer DEFAULT 60 NOT NULL,
    needs_review boolean DEFAULT false NOT NULL,
    expiration_notice_sent_at timestamp with time zone,
    late_fee_enabled boolean DEFAULT true NOT NULL,
    late_fee_initial_type text DEFAULT 'flat'::text NOT NULL,
    late_fee_accrual_amount numeric,
    late_fee_accrual_type text,
    late_fee_accrual_period text,
    late_fee_cap_amount numeric,
    late_fee_cap_type text,
    lease_source text DEFAULT 'esigned'::text NOT NULL,
    imported_pdf_url text,
    subleasing_allowed text DEFAULT 'with_consent'::text NOT NULL,
    extraction_extras jsonb,
    supersedes_lease_id uuid,
    CONSTRAINT leases_auto_renew_mode_check CHECK (((auto_renew_mode IS NULL) OR (auto_renew_mode = ANY (ARRAY['extend_same_term'::text, 'convert_to_month_to_month'::text])))),
    CONSTRAINT leases_auto_renew_mode_required CHECK (((auto_renew = false) OR (auto_renew_mode IS NOT NULL))),
    CONSTRAINT leases_late_fee_accrual_period_check CHECK ((late_fee_accrual_period = ANY (ARRAY['daily'::text, 'weekly'::text, 'monthly'::text]))),
    CONSTRAINT leases_late_fee_accrual_type_check CHECK ((late_fee_accrual_type = ANY (ARRAY['flat'::text, 'percent_of_rent'::text]))),
    CONSTRAINT leases_late_fee_cap_type_check CHECK ((late_fee_cap_type = ANY (ARRAY['flat'::text, 'percent_of_rent'::text]))),
    CONSTRAINT leases_late_fee_initial_type_check CHECK ((late_fee_initial_type = ANY (ARRAY['flat'::text, 'percent_of_rent'::text]))),
    CONSTRAINT leases_lease_source_check CHECK ((lease_source = ANY (ARRAY['esigned'::text, 'imported'::text]))),
    CONSTRAINT leases_lease_type_check CHECK ((lease_type = ANY (ARRAY['month_to_month'::text, 'fixed_term'::text, 'nnn_commercial'::text]))),
    CONSTRAINT leases_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'active'::text, 'expired'::text, 'terminated'::text]))),
    CONSTRAINT leases_subleasing_allowed_check CHECK ((subleasing_allowed = ANY (ARRAY['prohibited'::text, 'with_consent'::text, 'allowed'::text])))
);


--
-- Name: liability_insurance_policies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.liability_insurance_policies (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    lease_id uuid NOT NULL,
    carrier_name text,
    policy_number text,
    expiry_date date,
    document_url text,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: maintenance_comments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.maintenance_comments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    request_id uuid NOT NULL,
    user_id uuid,
    role text,
    message text NOT NULL,
    is_internal boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: maintenance_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.maintenance_requests (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    unit_id uuid NOT NULL,
    tenant_id uuid,
    landlord_id uuid NOT NULL,
    contractor_id uuid,
    title text NOT NULL,
    description text NOT NULL,
    priority text DEFAULT 'normal'::text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    estimated_cost numeric(10,2),
    actual_cost numeric(10,2),
    platform_fee numeric(10,2),
    scheduled_at timestamp with time zone,
    completed_at timestamp with time zone,
    photos text[] DEFAULT '{}'::text[],
    tenant_notes text,
    landlord_notes text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    man_hours numeric(6,2),
    assigned_at timestamp with time zone,
    category text DEFAULT 'general'::text NOT NULL,
    CONSTRAINT maintenance_requests_category_check CHECK ((category = ANY (ARRAY['general'::text, 'plumbing'::text, 'electrical'::text, 'hvac'::text, 'appliance'::text, 'landscape'::text, 'pest'::text, 'cleaning'::text, 'roofing'::text, 'structural'::text, 'pool'::text, 'locksmith'::text]))),
    CONSTRAINT maintenance_requests_priority_check CHECK ((priority = ANY (ARRAY['emergency'::text, 'high'::text, 'normal'::text, 'low'::text]))),
    CONSTRAINT maintenance_requests_status_check CHECK ((status = ANY (ARRAY['open'::text, 'awaiting_approval'::text, 'assigned'::text, 'in_progress'::text, 'completed'::text, 'cancelled'::text])))
);


--
-- Name: maintenance_worker_scopes; Type: TABLE; Schema: public; Owner: -
--

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
    CONSTRAINT maintenance_worker_scopes_job_categories_check CHECK ((job_categories <@ ARRAY['general'::text, 'plumbing'::text, 'electrical'::text, 'hvac'::text, 'appliance'::text, 'landscape'::text, 'pest'::text, 'cleaning'::text, 'roofing'::text, 'structural'::text, 'pool'::text, 'locksmith'::text]))
);


--
-- Name: mobile_homes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mobile_homes (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    current_owner_tenant_id uuid,
    unit_id uuid,
    year integer,
    make text,
    model text,
    serial_number text,
    hud_label_number text,
    length_ft numeric(5,1),
    width_ft numeric(5,1),
    manufactured_date date,
    removed_at timestamp with time zone,
    removed_reason text,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notifications (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    user_id uuid NOT NULL,
    type text NOT NULL,
    title text NOT NULL,
    body text NOT NULL,
    read boolean DEFAULT false,
    action_url text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: onsite_manager_scopes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.onsite_manager_scopes (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    user_id uuid NOT NULL,
    landlord_id uuid NOT NULL,
    property_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    unit_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payments (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    unit_id uuid,
    lease_id uuid,
    tenant_id uuid,
    landlord_id uuid NOT NULL,
    type text NOT NULL,
    amount numeric(10,2) NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    stripe_payment_intent_id text,
    stripe_charge_id text,
    ach_trace_number text,
    entry_description text NOT NULL,
    return_code text,
    return_reason text,
    zero_tolerance_flag boolean DEFAULT false,
    due_date date NOT NULL,
    processed_at timestamp with time zone,
    settled_at timestamp with time zone,
    retry_count integer DEFAULT 0,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    lease_fee_id uuid,
    invoice_id uuid,
    CONSTRAINT payments_entry_description_check CHECK ((entry_description = ANY (ARRAY['RENT'::text, 'SUBSCRIP'::text, 'DEPOSIT'::text, 'UTILITY'::text, 'ONTIMEPAY'::text, 'LATEFEE'::text]))),
    CONSTRAINT payments_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'settled'::text, 'failed'::text, 'returned'::text]))),
    CONSTRAINT payments_type_check CHECK ((type = ANY (ARRAY['rent'::text, 'fee'::text, 'deposit'::text, 'utility'::text, 'float_fee'::text, 'late_fee'::text, 'platform_fee'::text])))
);


--
-- Name: payroll_run_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payroll_run_lines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    run_id uuid NOT NULL,
    employee_id uuid NOT NULL,
    pay_type character varying(20) NOT NULL,
    hours_worked numeric(8,2),
    gross_pay numeric(10,2) NOT NULL,
    federal_tax numeric(10,2) DEFAULT 0 NOT NULL,
    state_tax numeric(10,2) DEFAULT 0 NOT NULL,
    ss_tax numeric(10,2) DEFAULT 0 NOT NULL,
    medicare_tax numeric(10,2) DEFAULT 0 NOT NULL,
    other_deductions numeric(10,2) DEFAULT 0,
    net_pay numeric(10,2) NOT NULL,
    memo text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: payroll_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payroll_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    landlord_id uuid,
    period_start date NOT NULL,
    period_end date NOT NULL,
    pay_date date NOT NULL,
    pay_frequency character varying(20) NOT NULL,
    status character varying(20) DEFAULT 'draft'::character varying NOT NULL,
    total_gross numeric(12,2) DEFAULT 0,
    total_federal_tax numeric(12,2) DEFAULT 0,
    total_state_tax numeric(12,2) DEFAULT 0,
    total_ss numeric(12,2) DEFAULT 0,
    total_medicare numeric(12,2) DEFAULT 0,
    total_net numeric(12,2) DEFAULT 0,
    employee_count integer DEFAULT 0,
    notes text,
    approved_at timestamp with time zone,
    approved_by uuid,
    voided_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: pending_tenant_intents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pending_tenant_intents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    landlord_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    parser_status text DEFAULT 'not_uploaded'::text NOT NULL,
    imported_pdf_url text,
    parser_output jsonb,
    parser_flags jsonb,
    parser_error text,
    parser_started_at timestamp with time zone,
    parser_finished_at timestamp with time zone,
    resolved_at timestamp with time zone,
    resolved_lease_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pending_tenant_intents_parser_status_check CHECK ((parser_status = ANY (ARRAY['not_uploaded'::text, 'parsing'::text, 'parsed'::text, 'mismatch'::text, 'error'::text, 'resolved'::text])))
);


--
-- Name: platform_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_events (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    subject_type text NOT NULL,
    subject_id uuid NOT NULL,
    event_type text NOT NULL,
    actor_user_id uuid,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT platform_events_event_type_check CHECK ((event_type = ANY (ARRAY['invitation.created'::text, 'invitation.resent'::text, 'invitation.viewed'::text, 'invitation.accepted'::text, 'invitation.expired'::text, 'invitation.revoked'::text]))),
    CONSTRAINT platform_events_subject_type_check CHECK ((subject_type = 'invitation'::text))
);


--
-- Name: properties; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.properties (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    landlord_id uuid NOT NULL,
    name text NOT NULL,
    street1 text NOT NULL,
    street2 text,
    city text NOT NULL,
    state text DEFAULT 'AZ'::text NOT NULL,
    zip text NOT NULL,
    type text DEFAULT 'mixed'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    unit_types text[] DEFAULT '{}'::text[],
    review_status text DEFAULT 'active'::text NOT NULL,
    timezone text DEFAULT 'America/Phoenix'::text NOT NULL,
    late_fee_enabled boolean DEFAULT true NOT NULL,
    late_fee_grace_days integer DEFAULT 5 NOT NULL,
    late_fee_initial_amount numeric DEFAULT 15.00 NOT NULL,
    late_fee_initial_type text DEFAULT 'flat'::text NOT NULL,
    late_fee_accrual_amount numeric,
    late_fee_accrual_type text,
    late_fee_accrual_period text,
    late_fee_cap_amount numeric,
    late_fee_cap_type text,
    deposit_handling_mode text DEFAULT 'landlord_held'::text NOT NULL,
    deposit_interest_rate_annual numeric,
    deposit_interest_accrual_method text,
    deposit_interest_payment_cadence text,
    CONSTRAINT properties_deposit_handling_mode_check CHECK ((deposit_handling_mode = ANY (ARRAY['gam_escrow'::text, 'landlord_held'::text]))),
    CONSTRAINT properties_deposit_interest_accrual_method_check CHECK ((deposit_interest_accrual_method = ANY (ARRAY['simple'::text, 'compound'::text]))),
    CONSTRAINT properties_deposit_interest_payment_cadence_check CHECK ((deposit_interest_payment_cadence = ANY (ARRAY['annual'::text, 'at_return'::text, 'on_anniversary'::text]))),
    CONSTRAINT properties_late_fee_accrual_period_check CHECK ((late_fee_accrual_period = ANY (ARRAY['daily'::text, 'weekly'::text, 'monthly'::text]))),
    CONSTRAINT properties_late_fee_accrual_type_check CHECK ((late_fee_accrual_type = ANY (ARRAY['flat'::text, 'percent_of_rent'::text]))),
    CONSTRAINT properties_late_fee_cap_type_check CHECK ((late_fee_cap_type = ANY (ARRAY['flat'::text, 'percent_of_rent'::text]))),
    CONSTRAINT properties_late_fee_initial_type_check CHECK ((late_fee_initial_type = ANY (ARRAY['flat'::text, 'percent_of_rent'::text]))),
    CONSTRAINT properties_review_status_check CHECK ((review_status = ANY (ARRAY['active'::text, 'pending_review'::text, 'rejected'::text])))
);


--
-- Name: property_duplicate_flags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.property_duplicate_flags (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    property_id uuid NOT NULL,
    conflicting_property_id uuid NOT NULL,
    reason text DEFAULT 'duplicate_address'::text NOT NULL,
    normalized_key text,
    detected_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    resolved_by uuid,
    resolution text,
    notes text,
    CONSTRAINT property_duplicate_flags_resolution_check CHECK ((resolution = ANY (ARRAY['approved_separate'::text, 'merged'::text, 'rejected'::text])))
);


--
-- Name: property_manager_scopes; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: reserve_fund_ledger; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reserve_fund_ledger (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    type text NOT NULL,
    amount numeric(10,2) NOT NULL,
    balance_after numeric(10,2) NOT NULL,
    reference_id uuid,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT reserve_fund_ledger_type_check CHECK ((type = ANY (ARRAY['contribution'::text, 'disbursement_cover'::text, 'replenishment'::text, 'interest'::text, 'adjustment'::text])))
);


--
-- Name: reserve_fund_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reserve_fund_state (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    balance numeric(10,2) DEFAULT 0 NOT NULL,
    target_balance numeric(10,2) DEFAULT 0 NOT NULL,
    phase integer DEFAULT 1 NOT NULL,
    reserve_rate numeric(5,4) DEFAULT 1.00 NOT NULL,
    monthly_contribution numeric(10,2) DEFAULT 0,
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT reserve_fund_state_phase_check CHECK ((phase = ANY (ARRAY[1, 2, 3])))
);


--
-- Name: rvs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rvs (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    current_owner_tenant_id uuid,
    unit_id uuid,
    year integer,
    make text,
    model text,
    vin text,
    length_ft numeric(5,1),
    num_slides integer DEFAULT 0 NOT NULL,
    hookup_class text,
    license_plate text,
    plate_state text,
    plate_expiry_date date,
    removed_at timestamp with time zone,
    removed_reason text,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT rvs_hookup_class_check CHECK (((hookup_class IS NULL) OR (hookup_class = ANY (ARRAY['20amp'::text, '30amp'::text, '50amp'::text, 'shore_only'::text, 'none'::text]))))
);


--
-- Name: security_deposits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.security_deposits (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    unit_id uuid NOT NULL,
    lease_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    total_amount numeric(10,2) NOT NULL,
    collected_amount numeric(10,2) DEFAULT 0 NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    flex_deposit_enabled boolean DEFAULT false,
    installment_count integer,
    installment_amount numeric(10,2),
    installments_paid integer DEFAULT 0,
    installments_remaining integer,
    next_installment_date date,
    interest_accrued numeric(10,2) DEFAULT 0,
    disbursed_to_landlord numeric(10,2) DEFAULT 0,
    disbursed_at timestamp with time zone,
    damage_claimed numeric(10,2) DEFAULT 0,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    held_by text NOT NULL,
    CONSTRAINT security_deposits_held_by_check CHECK ((held_by = ANY (ARRAY['gam_escrow'::text, 'landlord'::text]))),
    CONSTRAINT security_deposits_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'funded'::text, 'partial'::text, 'disbursed'::text, 'claimed'::text])))
);


--
-- Name: subleases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subleases (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    master_lease_id uuid NOT NULL,
    sublessee_tenant_id uuid NOT NULL,
    sublessor_tenant_id uuid NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    start_date date NOT NULL,
    end_date date,
    sub_monthly_amount numeric(10,2) NOT NULL,
    master_share_amount numeric(10,2) NOT NULL,
    landlord_consent_date date,
    sublease_document_url text,
    notes text,
    terminated_at timestamp with time zone,
    terminated_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT subleases_distinct_parties CHECK ((sublessee_tenant_id <> sublessor_tenant_id)),
    CONSTRAINT subleases_share_not_negative CHECK ((master_share_amount >= (0)::numeric)),
    CONSTRAINT subleases_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'active'::text, 'terminated'::text]))),
    CONSTRAINT subleases_sub_amount_positive CHECK ((sub_monthly_amount > (0)::numeric))
);


--
-- Name: team_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_members (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    landlord_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text DEFAULT 'property_manager'::text NOT NULL,
    permissions jsonb,
    status text DEFAULT 'active'::text NOT NULL,
    invited_at timestamp with time zone DEFAULT now(),
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: tenant_identifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenant_identifications (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    tenant_id uuid NOT NULL,
    id_type text NOT NULL,
    id_number text NOT NULL,
    issuing_state text,
    issuing_country text DEFAULT 'US'::text NOT NULL,
    expiry_date date,
    document_url text,
    is_primary boolean DEFAULT false NOT NULL,
    verified_at timestamp with time zone,
    verified_by uuid,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tenant_identifications_id_type_check CHECK ((id_type = ANY (ARRAY['drivers_license'::text, 'state_id'::text, 'passport'::text, 'military_id'::text, 'tribal_id'::text, 'permanent_resident_card'::text, 'other'::text])))
);


--
-- Name: tenants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenants (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    user_id uuid NOT NULL,
    stripe_customer_id text,
    ach_verified boolean DEFAULT false,
    bank_last4 text,
    bank_routing_last4 text,
    ssi_ssdi boolean DEFAULT false,
    income_arrival_day integer,
    on_time_pay_enrolled boolean DEFAULT false,
    float_fee_active boolean DEFAULT false,
    credit_reporting_enrolled boolean DEFAULT false,
    flex_deposit_enrolled boolean DEFAULT false,
    late_payment_count integer DEFAULT 0,
    on_time_pay_invite_sent_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    theme_accent text,
    font_style text,
    bio text,
    avatar_url text,
    platform_status text DEFAULT 'active'::text NOT NULL,
    onboarding_source text DEFAULT 'applied'::text NOT NULL,
    date_of_birth date,
    mailing_address text,
    CONSTRAINT tenants_income_arrival_day_check CHECK (((income_arrival_day >= 1) AND (income_arrival_day <= 28))),
    CONSTRAINT tenants_onboarding_source_check CHECK ((onboarding_source = ANY (ARRAY['applied'::text, 'onboarded'::text]))),
    CONSTRAINT tenants_platform_status_check CHECK ((platform_status = ANY (ARRAY['active'::text, 'suspended'::text, 'blocked'::text])))
);


--
-- Name: unit_applications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.unit_applications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    unit_id uuid,
    landlord_id uuid,
    first_name text NOT NULL,
    last_name text NOT NULL,
    email text NOT NULL,
    phone text,
    move_in_date date,
    monthly_income numeric(10,2),
    occupants integer DEFAULT 1,
    has_pets boolean DEFAULT false,
    pet_description text,
    message text,
    status text DEFAULT 'pending'::text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: unit_bookings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.unit_bookings (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    unit_id uuid NOT NULL,
    tenant_id uuid,
    guest_name text,
    guest_email text,
    guest_phone text,
    check_in date NOT NULL,
    check_out date NOT NULL,
    nights integer,
    total_amount numeric(10,2),
    booking_type text,
    status text DEFAULT 'confirmed'::text NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT unit_bookings_booking_type_check CHECK ((booking_type = ANY (ARRAY['nightly'::text, 'weekly'::text, 'lease_hold'::text]))),
    CONSTRAINT unit_bookings_status_check CHECK ((status = ANY (ARRAY['tentative'::text, 'confirmed'::text, 'checked_in'::text, 'checked_out'::text, 'cancelled'::text, 'no_show'::text])))
);


--
-- Name: unit_photos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.unit_photos (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    unit_id uuid NOT NULL,
    landlord_id uuid NOT NULL,
    url text NOT NULL,
    caption text,
    sort_order integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: units; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.units (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    property_id uuid NOT NULL,
    landlord_id uuid NOT NULL,
    unit_number text NOT NULL,
    bedrooms integer DEFAULT 1 NOT NULL,
    bathrooms numeric(3,1) DEFAULT 1.0 NOT NULL,
    sqft integer,
    status text DEFAULT 'vacant'::text NOT NULL,
    rent_amount numeric(10,2) NOT NULL,
    security_deposit numeric(10,2) DEFAULT 0 NOT NULL,
    on_time_pay_active boolean DEFAULT false,
    payment_block boolean DEFAULT false,
    payment_block_set_at timestamp with time zone,
    payment_block_set_by uuid,
    listed_vacant boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    available_date date,
    listing_description text,
    unit_type text DEFAULT 'apartment'::text,
    scheduled_activation_at timestamp with time zone,
    scheduled_activation_by uuid,
    nightly_rate numeric(10,2),
    weekly_rate numeric(10,2),
    is_bookable boolean DEFAULT false NOT NULL,
    lease_types_allowed text[] DEFAULT ARRAY['fixed_term'::text],
    check_in_time time without time zone,
    check_out_time time without time zone,
    amenities text[] DEFAULT ARRAY[]::text[],
    unit_description text,
    CONSTRAINT units_status_check CHECK ((status = ANY (ARRAY['vacant'::text, 'available'::text, 'active'::text, 'direct_pay'::text, 'delinquent'::text, 'suspended'::text]))),
    CONSTRAINT units_unit_type_check CHECK ((unit_type = ANY (ARRAY['apartment'::text, 'single_family'::text, 'rv_spot'::text, 'mobile_home'::text, 'storage'::text, 'commercial'::text])))
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    email text NOT NULL,
    password_hash text NOT NULL,
    role text NOT NULL,
    first_name text NOT NULL,
    last_name text NOT NULL,
    phone text,
    email_verified boolean DEFAULT false,
    email_verify_token text,
    reset_token text,
    reset_token_expires timestamp with time zone,
    last_login_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT users_role_check CHECK ((role = ANY (ARRAY['admin'::text, 'super_admin'::text, 'landlord'::text, 'tenant'::text, 'bookkeeper'::text, 'property_manager'::text, 'onsite_manager'::text, 'maintenance'::text])))
);


--
-- Name: utility_meter_readings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.utility_meter_readings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    meter_id uuid NOT NULL,
    reading_date date NOT NULL,
    reading_value numeric NOT NULL,
    billing_cycle_month date NOT NULL,
    created_by_user_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: utility_meter_units; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.utility_meter_units (
    meter_id uuid NOT NULL,
    unit_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: utility_meters; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.utility_meters (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    property_id uuid NOT NULL,
    utility_type text NOT NULL,
    label text NOT NULL,
    billing_method text NOT NULL,
    rate_per_unit numeric,
    base_fee numeric DEFAULT 0 NOT NULL,
    rubs_allocation_method text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT utility_meters_billing_method_check CHECK ((billing_method = ANY (ARRAY['submeter'::text, 'rubs'::text, 'master_bill_to_landlord'::text]))),
    CONSTRAINT utility_meters_check CHECK ((((billing_method = 'rubs'::text) AND (rubs_allocation_method IS NOT NULL)) OR ((billing_method <> 'rubs'::text) AND (rubs_allocation_method IS NULL)))),
    CONSTRAINT utility_meters_rubs_allocation_method_check CHECK ((rubs_allocation_method = ANY (ARRAY['occupant_count'::text, 'sqft'::text, 'bedrooms'::text, 'equal_split'::text]))),
    CONSTRAINT utility_meters_utility_type_check CHECK ((utility_type = ANY (ARRAY['water'::text, 'gas'::text, 'electric'::text, 'sewer'::text, 'trash'::text])))
);


--
-- Name: v_lease_active_tenants; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_lease_active_tenants AS
 SELECT lt.lease_id,
    lt.id AS lease_tenant_id,
    lt.tenant_id,
    lt.role,
    lt.status,
    lt.financial_responsibility,
    lt.responsibility_pct,
    lt.added_at,
    us.first_name,
    us.last_name,
    us.email,
    us.phone
   FROM ((public.lease_tenants lt
     JOIN public.tenants t ON ((t.id = lt.tenant_id)))
     JOIN public.users us ON ((us.id = t.user_id)))
  WHERE (lt.status = 'active'::text);


--
-- Name: v_unit_occupancy; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_unit_occupancy AS
 SELECT u.id AS unit_id,
    (primary_info.tenant_id IS NOT NULL) AS is_occupied,
    primary_info.tenant_id AS primary_tenant_id,
    primary_info.first_name AS primary_first_name,
    primary_info.last_name AS primary_last_name,
    primary_info.email AS primary_email,
    primary_info.phone AS primary_phone,
    primary_info.lease_id AS active_lease_id,
    COALESCE(counts.tenant_count, 0) AS tenant_count
   FROM ((public.units u
     LEFT JOIN LATERAL ( SELECT t.id AS tenant_id,
            us.first_name,
            us.last_name,
            us.email,
            us.phone,
            l.id AS lease_id
           FROM (((public.leases l
             JOIN public.lease_tenants lt ON ((lt.lease_id = l.id)))
             JOIN public.tenants t ON ((t.id = lt.tenant_id)))
             JOIN public.users us ON ((us.id = t.user_id)))
          WHERE ((l.unit_id = u.id) AND (l.status = 'active'::text) AND (lt.status = 'active'::text) AND (lt.role = 'primary'::text))
         LIMIT 1) primary_info ON (true))
     LEFT JOIN LATERAL ( SELECT (count(*))::integer AS tenant_count
           FROM (public.leases l
             JOIN public.lease_tenants lt ON ((lt.lease_id = l.id)))
          WHERE ((l.unit_id = u.id) AND (l.status = 'active'::text) AND (lt.status = 'active'::text))) counts ON (true));


--
-- Name: journal_entries entry_number; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journal_entries ALTER COLUMN entry_number SET DEFAULT nextval('public.journal_entries_entry_number_seq'::regclass);


--
-- Name: ach_monitoring_log ach_monitoring_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ach_monitoring_log
    ADD CONSTRAINT ach_monitoring_log_pkey PRIMARY KEY (id);


--
-- Name: audit_log audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);


--
-- Name: background_checks background_checks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.background_checks
    ADD CONSTRAINT background_checks_pkey PRIMARY KEY (id);


--
-- Name: bank_reconciliations bank_reconciliations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bank_reconciliations
    ADD CONSTRAINT bank_reconciliations_pkey PRIMARY KEY (id);


--
-- Name: bookkeeper_scopes bookkeeper_scopes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookkeeper_scopes
    ADD CONSTRAINT bookkeeper_scopes_pkey PRIMARY KEY (id);


--
-- Name: bookkeeper_scopes bookkeeper_scopes_user_id_landlord_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookkeeper_scopes
    ADD CONSTRAINT bookkeeper_scopes_user_id_landlord_id_key UNIQUE (user_id, landlord_id);


--
-- Name: books_accounts books_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.books_accounts
    ADD CONSTRAINT books_accounts_pkey PRIMARY KEY (id);


--
-- Name: books_bills books_bills_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.books_bills
    ADD CONSTRAINT books_bills_pkey PRIMARY KEY (id);


--
-- Name: books_contractors books_contractors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.books_contractors
    ADD CONSTRAINT books_contractors_pkey PRIMARY KEY (id);


--
-- Name: books_employees books_employees_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.books_employees
    ADD CONSTRAINT books_employees_pkey PRIMARY KEY (id);


--
-- Name: books_transactions books_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.books_transactions
    ADD CONSTRAINT books_transactions_pkey PRIMARY KEY (id);


--
-- Name: books_vendors books_vendors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.books_vendors
    ADD CONSTRAINT books_vendors_pkey PRIMARY KEY (id);


--
-- Name: bulletin_posts bulletin_posts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bulletin_posts
    ADD CONSTRAINT bulletin_posts_pkey PRIMARY KEY (id);


--
-- Name: bulletin_reveal_log bulletin_reveal_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bulletin_reveal_log
    ADD CONSTRAINT bulletin_reveal_log_pkey PRIMARY KEY (id);


--
-- Name: bulletin_votes bulletin_votes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bulletin_votes
    ADD CONSTRAINT bulletin_votes_pkey PRIMARY KEY (id);


--
-- Name: bulletin_votes bulletin_votes_post_id_tenant_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bulletin_votes
    ADD CONSTRAINT bulletin_votes_post_id_tenant_id_key UNIQUE (post_id, tenant_id);


--
-- Name: contractors contractors_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contractors
    ADD CONSTRAINT contractors_email_key UNIQUE (email);


--
-- Name: contractors contractors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contractors
    ADD CONSTRAINT contractors_pkey PRIMARY KEY (id);


--
-- Name: disbursements disbursements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.disbursements
    ADD CONSTRAINT disbursements_pkey PRIMARY KEY (id);


--
-- Name: document_batches document_batches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_batches
    ADD CONSTRAINT document_batches_pkey PRIMARY KEY (id);


--
-- Name: documents documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_pkey PRIMARY KEY (id);


--
-- Name: emergency_contacts emergency_contacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.emergency_contacts
    ADD CONSTRAINT emergency_contacts_pkey PRIMARY KEY (id);


--
-- Name: fitness_body_weight_logs fitness_body_weight_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fitness_body_weight_logs
    ADD CONSTRAINT fitness_body_weight_logs_pkey PRIMARY KEY (id);


--
-- Name: fitness_body_weight_logs fitness_body_weight_logs_user_id_logged_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fitness_body_weight_logs
    ADD CONSTRAINT fitness_body_weight_logs_user_id_logged_date_key UNIQUE (user_id, logged_date);


--
-- Name: fitness_days fitness_days_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fitness_days
    ADD CONSTRAINT fitness_days_pkey PRIMARY KEY (id);


--
-- Name: fitness_exercises fitness_exercises_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fitness_exercises
    ADD CONSTRAINT fitness_exercises_pkey PRIMARY KEY (id);


--
-- Name: fitness_milestones fitness_milestones_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fitness_milestones
    ADD CONSTRAINT fitness_milestones_pkey PRIMARY KEY (id);


--
-- Name: fitness_profiles fitness_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fitness_profiles
    ADD CONSTRAINT fitness_profiles_pkey PRIMARY KEY (id);


--
-- Name: fitness_profiles fitness_profiles_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fitness_profiles
    ADD CONSTRAINT fitness_profiles_user_id_key UNIQUE (user_id);


--
-- Name: fitness_routines fitness_routines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fitness_routines
    ADD CONSTRAINT fitness_routines_pkey PRIMARY KEY (id);


--
-- Name: fitness_sections fitness_sections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fitness_sections
    ADD CONSTRAINT fitness_sections_pkey PRIMARY KEY (id);


--
-- Name: fitness_set_logs fitness_set_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fitness_set_logs
    ADD CONSTRAINT fitness_set_logs_pkey PRIMARY KEY (id);


--
-- Name: fitness_workout_logs fitness_workout_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fitness_workout_logs
    ADD CONSTRAINT fitness_workout_logs_pkey PRIMARY KEY (id);


--
-- Name: float_account_state float_account_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.float_account_state
    ADD CONSTRAINT float_account_state_pkey PRIMARY KEY (id);


--
-- Name: invitations invitations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invitations
    ADD CONSTRAINT invitations_pkey PRIMARY KEY (id);


--
-- Name: invitations invitations_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invitations
    ADD CONSTRAINT invitations_token_key UNIQUE (token);


--
-- Name: invoice_sequences invoice_sequences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_sequences
    ADD CONSTRAINT invoice_sequences_pkey PRIMARY KEY (landlord_id, year);


--
-- Name: invoices invoices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_pkey PRIMARY KEY (id);


--
-- Name: journal_entries journal_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journal_entries
    ADD CONSTRAINT journal_entries_pkey PRIMARY KEY (id);


--
-- Name: journal_entry_lines journal_entry_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journal_entry_lines
    ADD CONSTRAINT journal_entry_lines_pkey PRIMARY KEY (id);


--
-- Name: landlords landlords_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.landlords
    ADD CONSTRAINT landlords_pkey PRIMARY KEY (id);


--
-- Name: lease_document_fields lease_document_fields_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lease_document_fields
    ADD CONSTRAINT lease_document_fields_pkey PRIMARY KEY (id);


--
-- Name: lease_document_signers lease_document_signers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lease_document_signers
    ADD CONSTRAINT lease_document_signers_pkey PRIMARY KEY (id);


--
-- Name: lease_document_signers lease_document_signers_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lease_document_signers
    ADD CONSTRAINT lease_document_signers_token_key UNIQUE (token);


--
-- Name: lease_documents lease_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lease_documents
    ADD CONSTRAINT lease_documents_pkey PRIMARY KEY (id);


--
-- Name: lease_fees lease_fees_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lease_fees
    ADD CONSTRAINT lease_fees_pkey PRIMARY KEY (id);


--
-- Name: lease_occupants lease_occupants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lease_occupants
    ADD CONSTRAINT lease_occupants_pkey PRIMARY KEY (id);


--
-- Name: lease_pets lease_pets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lease_pets
    ADD CONSTRAINT lease_pets_pkey PRIMARY KEY (id);


--
-- Name: lease_template_fields lease_template_fields_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lease_template_fields
    ADD CONSTRAINT lease_template_fields_pkey PRIMARY KEY (id);


--
-- Name: lease_templates lease_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lease_templates
    ADD CONSTRAINT lease_templates_pkey PRIMARY KEY (id);


--
-- Name: lease_tenants lease_tenants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lease_tenants
    ADD CONSTRAINT lease_tenants_pkey PRIMARY KEY (id);


--
-- Name: lease_utility_assignments lease_utility_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lease_utility_assignments
    ADD CONSTRAINT lease_utility_assignments_pkey PRIMARY KEY (lease_id, meter_id);


--
-- Name: lease_utility_responsibilities lease_utility_responsibilities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lease_utility_responsibilities
    ADD CONSTRAINT lease_utility_responsibilities_pkey PRIMARY KEY (lease_id, utility_type);


--
-- Name: lease_vehicles lease_vehicles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lease_vehicles
    ADD CONSTRAINT lease_vehicles_pkey PRIMARY KEY (id);


--
-- Name: leases leases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leases
    ADD CONSTRAINT leases_pkey PRIMARY KEY (id);


--
-- Name: liability_insurance_policies liability_insurance_policies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.liability_insurance_policies
    ADD CONSTRAINT liability_insurance_policies_pkey PRIMARY KEY (id);


--
-- Name: maintenance_comments maintenance_comments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_comments
    ADD CONSTRAINT maintenance_comments_pkey PRIMARY KEY (id);


--
-- Name: maintenance_requests maintenance_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_requests
    ADD CONSTRAINT maintenance_requests_pkey PRIMARY KEY (id);


--
-- Name: maintenance_worker_scopes maintenance_worker_scopes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_worker_scopes
    ADD CONSTRAINT maintenance_worker_scopes_pkey PRIMARY KEY (id);


--
-- Name: maintenance_worker_scopes maintenance_worker_scopes_user_id_landlord_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_worker_scopes
    ADD CONSTRAINT maintenance_worker_scopes_user_id_landlord_id_key UNIQUE (user_id, landlord_id);


--
-- Name: mobile_homes mobile_homes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mobile_homes
    ADD CONSTRAINT mobile_homes_pkey PRIMARY KEY (id);


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);


--
-- Name: onsite_manager_scopes onsite_manager_scopes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.onsite_manager_scopes
    ADD CONSTRAINT onsite_manager_scopes_pkey PRIMARY KEY (id);


--
-- Name: onsite_manager_scopes onsite_manager_scopes_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.onsite_manager_scopes
    ADD CONSTRAINT onsite_manager_scopes_user_id_key UNIQUE (user_id);


--
-- Name: payments payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_pkey PRIMARY KEY (id);


--
-- Name: payroll_run_lines payroll_run_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_run_lines
    ADD CONSTRAINT payroll_run_lines_pkey PRIMARY KEY (id);


--
-- Name: payroll_runs payroll_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_runs
    ADD CONSTRAINT payroll_runs_pkey PRIMARY KEY (id);


--
-- Name: pending_tenant_intents pending_tenant_intents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pending_tenant_intents
    ADD CONSTRAINT pending_tenant_intents_pkey PRIMARY KEY (id);


--
-- Name: pending_tenant_intents pending_tenant_intents_tenant_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pending_tenant_intents
    ADD CONSTRAINT pending_tenant_intents_tenant_id_key UNIQUE (tenant_id);


--
-- Name: platform_events platform_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_events
    ADD CONSTRAINT platform_events_pkey PRIMARY KEY (id);


--
-- Name: properties properties_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.properties
    ADD CONSTRAINT properties_pkey PRIMARY KEY (id);


--
-- Name: property_duplicate_flags property_duplicate_flags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.property_duplicate_flags
    ADD CONSTRAINT property_duplicate_flags_pkey PRIMARY KEY (id);


--
-- Name: property_manager_scopes property_manager_scopes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.property_manager_scopes
    ADD CONSTRAINT property_manager_scopes_pkey PRIMARY KEY (id);


--
-- Name: property_manager_scopes property_manager_scopes_user_id_landlord_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.property_manager_scopes
    ADD CONSTRAINT property_manager_scopes_user_id_landlord_id_key UNIQUE (user_id, landlord_id);


--
-- Name: reserve_fund_ledger reserve_fund_ledger_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reserve_fund_ledger
    ADD CONSTRAINT reserve_fund_ledger_pkey PRIMARY KEY (id);


--
-- Name: reserve_fund_state reserve_fund_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reserve_fund_state
    ADD CONSTRAINT reserve_fund_state_pkey PRIMARY KEY (id);


--
-- Name: rvs rvs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rvs
    ADD CONSTRAINT rvs_pkey PRIMARY KEY (id);


--
-- Name: security_deposits security_deposits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.security_deposits
    ADD CONSTRAINT security_deposits_pkey PRIMARY KEY (id);


--
-- Name: subleases subleases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subleases
    ADD CONSTRAINT subleases_pkey PRIMARY KEY (id);


--
-- Name: team_members team_members_landlord_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_members
    ADD CONSTRAINT team_members_landlord_id_user_id_key UNIQUE (landlord_id, user_id);


--
-- Name: team_members team_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_members
    ADD CONSTRAINT team_members_pkey PRIMARY KEY (id);


--
-- Name: tenant_identifications tenant_identifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_identifications
    ADD CONSTRAINT tenant_identifications_pkey PRIMARY KEY (id);


--
-- Name: tenants tenants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenants
    ADD CONSTRAINT tenants_pkey PRIMARY KEY (id);


--
-- Name: unit_applications unit_applications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.unit_applications
    ADD CONSTRAINT unit_applications_pkey PRIMARY KEY (id);


--
-- Name: unit_bookings unit_bookings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.unit_bookings
    ADD CONSTRAINT unit_bookings_pkey PRIMARY KEY (id);


--
-- Name: unit_photos unit_photos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.unit_photos
    ADD CONSTRAINT unit_photos_pkey PRIMARY KEY (id);


--
-- Name: units units_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.units
    ADD CONSTRAINT units_pkey PRIMARY KEY (id);


--
-- Name: units units_property_id_unit_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.units
    ADD CONSTRAINT units_property_id_unit_number_key UNIQUE (property_id, unit_number);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: utility_meter_readings utility_meter_readings_meter_id_billing_cycle_month_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.utility_meter_readings
    ADD CONSTRAINT utility_meter_readings_meter_id_billing_cycle_month_key UNIQUE (meter_id, billing_cycle_month);


--
-- Name: utility_meter_readings utility_meter_readings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.utility_meter_readings
    ADD CONSTRAINT utility_meter_readings_pkey PRIMARY KEY (id);


--
-- Name: utility_meter_units utility_meter_units_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.utility_meter_units
    ADD CONSTRAINT utility_meter_units_pkey PRIMARY KEY (meter_id, unit_id);


--
-- Name: utility_meters utility_meters_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.utility_meters
    ADD CONSTRAINT utility_meters_pkey PRIMARY KEY (id);


--
-- Name: idx_audit_entity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_entity ON public.audit_log USING btree (entity_type, entity_id);


--
-- Name: idx_bookkeeper_scopes_landlord; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bookkeeper_scopes_landlord ON public.bookkeeper_scopes USING btree (landlord_id);


--
-- Name: idx_bookkeeper_scopes_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bookkeeper_scopes_user ON public.bookkeeper_scopes USING btree (user_id);


--
-- Name: idx_bp_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bp_created ON public.bulletin_posts USING btree (created_at);


--
-- Name: idx_bp_property; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bp_property ON public.bulletin_posts USING btree (property_id);


--
-- Name: idx_disbursements_landlord; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_disbursements_landlord ON public.disbursements USING btree (landlord_id);


--
-- Name: idx_disbursements_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_disbursements_target ON public.disbursements USING btree (target_date);


--
-- Name: idx_document_batches_landlord; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_batches_landlord ON public.document_batches USING btree (landlord_id);


--
-- Name: idx_emergency_contacts_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_emergency_contacts_tenant ON public.emergency_contacts USING btree (tenant_id);


--
-- Name: idx_fitness_body_weight_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fitness_body_weight_user ON public.fitness_body_weight_logs USING btree (user_id);


--
-- Name: idx_fitness_days_routine; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fitness_days_routine ON public.fitness_days USING btree (routine_id);


--
-- Name: idx_fitness_exercises_section; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fitness_exercises_section ON public.fitness_exercises USING btree (section_id);


--
-- Name: idx_fitness_milestones_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fitness_milestones_user ON public.fitness_milestones USING btree (user_id);


--
-- Name: idx_fitness_profiles_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fitness_profiles_user ON public.fitness_profiles USING btree (user_id);


--
-- Name: idx_fitness_routines_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fitness_routines_user ON public.fitness_routines USING btree (user_id);


--
-- Name: idx_fitness_sections_day; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fitness_sections_day ON public.fitness_sections USING btree (day_id);


--
-- Name: idx_fitness_set_logs_exercise; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fitness_set_logs_exercise ON public.fitness_set_logs USING btree (exercise_name);


--
-- Name: idx_fitness_set_logs_log; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fitness_set_logs_log ON public.fitness_set_logs USING btree (log_id);


--
-- Name: idx_fitness_set_logs_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fitness_set_logs_user ON public.fitness_set_logs USING btree (user_id);


--
-- Name: idx_fitness_workout_logs_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fitness_workout_logs_date ON public.fitness_workout_logs USING btree (logged_date);


--
-- Name: idx_fitness_workout_logs_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fitness_workout_logs_user ON public.fitness_workout_logs USING btree (user_id);


--
-- Name: idx_invitations_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invitations_email ON public.invitations USING btree (lower(email));


--
-- Name: idx_invitations_landlord; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invitations_landlord ON public.invitations USING btree (landlord_id);


--
-- Name: idx_invitations_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invitations_status ON public.invitations USING btree (status) WHERE (status = 'pending'::text);


--
-- Name: idx_invitations_token; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invitations_token ON public.invitations USING btree (token);


--
-- Name: idx_invoices_due_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invoices_due_date ON public.invoices USING btree (due_date);


--
-- Name: idx_invoices_landlord; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invoices_landlord ON public.invoices USING btree (landlord_id);


--
-- Name: idx_invoices_lease; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invoices_lease ON public.invoices USING btree (lease_id);


--
-- Name: idx_invoices_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invoices_status ON public.invoices USING btree (status);


--
-- Name: idx_invoices_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invoices_tenant ON public.invoices USING btree (tenant_id);


--
-- Name: idx_invoices_unit; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invoices_unit ON public.invoices USING btree (unit_id);


--
-- Name: idx_landlords_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_landlords_user_id ON public.landlords USING btree (user_id);


--
-- Name: idx_ld_landlord; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ld_landlord ON public.lease_documents USING btree (landlord_id);


--
-- Name: idx_ld_lease; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ld_lease ON public.lease_documents USING btree (lease_id);


--
-- Name: idx_ld_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ld_status ON public.lease_documents USING btree (status) WHERE (status = ANY (ARRAY['sent'::text, 'in_progress'::text]));


--
-- Name: idx_ld_unit; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ld_unit ON public.lease_documents USING btree (unit_id);


--
-- Name: idx_ldf_document; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ldf_document ON public.lease_document_fields USING btree (document_id);


--
-- Name: idx_ldf_signer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ldf_signer ON public.lease_document_fields USING btree (signer_id);


--
-- Name: idx_lds_doc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lds_doc ON public.lease_document_signers USING btree (document_id);


--
-- Name: idx_lds_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lds_email ON public.lease_document_signers USING btree (email);


--
-- Name: idx_lds_token; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lds_token ON public.lease_document_signers USING btree (token);


--
-- Name: idx_lease_documents_batch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lease_documents_batch ON public.lease_documents USING btree (batch_id);


--
-- Name: idx_lease_fees_fee_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lease_fees_fee_type ON public.lease_fees USING btree (fee_type);


--
-- Name: idx_lease_fees_lease_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lease_fees_lease_id ON public.lease_fees USING btree (lease_id);


--
-- Name: idx_lease_occupants_lease; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lease_occupants_lease ON public.lease_occupants USING btree (lease_id);


--
-- Name: idx_lease_pets_lease; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lease_pets_lease ON public.lease_pets USING btree (lease_id);


--
-- Name: idx_lease_templates_landlord; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lease_templates_landlord ON public.lease_templates USING btree (landlord_id) WHERE (is_active = true);


--
-- Name: idx_lease_utility_assignments_meter_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lease_utility_assignments_meter_id ON public.lease_utility_assignments USING btree (meter_id);


--
-- Name: idx_lease_utility_responsibilities_lease_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lease_utility_responsibilities_lease_id ON public.lease_utility_responsibilities USING btree (lease_id);


--
-- Name: idx_lease_vehicles_lease; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lease_vehicles_lease ON public.lease_vehicles USING btree (lease_id);


--
-- Name: idx_leases_end_date_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_leases_end_date_active ON public.leases USING btree (end_date) WHERE ((status = 'active'::text) AND (end_date IS NOT NULL));


--
-- Name: idx_leases_unit; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_leases_unit ON public.leases USING btree (unit_id);


--
-- Name: idx_liability_insurance_lease; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_liability_insurance_lease ON public.liability_insurance_policies USING btree (lease_id);


--
-- Name: idx_ltf_template; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ltf_template ON public.lease_template_fields USING btree (template_id);


--
-- Name: idx_maint_comments_request; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_maint_comments_request ON public.maintenance_comments USING btree (request_id);


--
-- Name: idx_maint_scopes_landlord; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_maint_scopes_landlord ON public.maintenance_worker_scopes USING btree (landlord_id);


--
-- Name: idx_maint_scopes_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_maint_scopes_user ON public.maintenance_worker_scopes USING btree (user_id);


--
-- Name: idx_maintenance_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_maintenance_status ON public.maintenance_requests USING btree (status);


--
-- Name: idx_maintenance_unit; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_maintenance_unit ON public.maintenance_requests USING btree (unit_id);


--
-- Name: idx_mobile_homes_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mobile_homes_owner ON public.mobile_homes USING btree (current_owner_tenant_id);


--
-- Name: idx_mobile_homes_unit; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mobile_homes_unit ON public.mobile_homes USING btree (unit_id) WHERE (removed_at IS NULL);


--
-- Name: idx_notifications_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notifications_user ON public.notifications USING btree (user_id, read);


--
-- Name: idx_onsite_scopes_landlord; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_onsite_scopes_landlord ON public.onsite_manager_scopes USING btree (landlord_id);


--
-- Name: idx_payments_due_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payments_due_date ON public.payments USING btree (due_date);


--
-- Name: idx_payments_invoice_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payments_invoice_id ON public.payments USING btree (invoice_id);


--
-- Name: idx_payments_landlord; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payments_landlord ON public.payments USING btree (landlord_id);


--
-- Name: idx_payments_lease_fee_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payments_lease_fee_id ON public.payments USING btree (lease_fee_id);


--
-- Name: idx_payments_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payments_status ON public.payments USING btree (status);


--
-- Name: idx_payments_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payments_tenant ON public.payments USING btree (tenant_id);


--
-- Name: idx_payments_unit; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payments_unit ON public.payments USING btree (unit_id);


--
-- Name: idx_pdf_conflicting; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pdf_conflicting ON public.property_duplicate_flags USING btree (conflicting_property_id);


--
-- Name: idx_pdf_property; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pdf_property ON public.property_duplicate_flags USING btree (property_id);


--
-- Name: idx_pdf_unresolved; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pdf_unresolved ON public.property_duplicate_flags USING btree (resolved_at) WHERE (resolved_at IS NULL);


--
-- Name: idx_pending_tenant_intents_landlord; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pending_tenant_intents_landlord ON public.pending_tenant_intents USING btree (landlord_id) WHERE (resolved_at IS NULL);


--
-- Name: idx_pending_tenant_intents_parser_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pending_tenant_intents_parser_status ON public.pending_tenant_intents USING btree (parser_status) WHERE (parser_status = ANY (ARRAY['parsing'::text, 'parsed'::text, 'mismatch'::text, 'error'::text]));


--
-- Name: idx_platform_events_actor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_platform_events_actor ON public.platform_events USING btree (actor_user_id);


--
-- Name: idx_platform_events_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_platform_events_created ON public.platform_events USING btree (created_at DESC);


--
-- Name: idx_platform_events_subject; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_platform_events_subject ON public.platform_events USING btree (subject_type, subject_id);


--
-- Name: idx_platform_events_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_platform_events_type ON public.platform_events USING btree (event_type);


--
-- Name: idx_pm_scopes_landlord; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pm_scopes_landlord ON public.property_manager_scopes USING btree (landlord_id);


--
-- Name: idx_pm_scopes_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pm_scopes_user ON public.property_manager_scopes USING btree (user_id);


--
-- Name: idx_properties_landlord; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_properties_landlord ON public.properties USING btree (landlord_id);


--
-- Name: idx_rvs_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rvs_owner ON public.rvs USING btree (current_owner_tenant_id);


--
-- Name: idx_rvs_unit; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rvs_unit ON public.rvs USING btree (unit_id) WHERE (removed_at IS NULL);


--
-- Name: idx_subleases_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subleases_active ON public.subleases USING btree (master_lease_id) WHERE (status = 'active'::text);


--
-- Name: idx_subleases_master; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subleases_master ON public.subleases USING btree (master_lease_id);


--
-- Name: idx_subleases_sublessee; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subleases_sublessee ON public.subleases USING btree (sublessee_tenant_id);


--
-- Name: idx_subleases_sublessor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subleases_sublessor ON public.subleases USING btree (sublessor_tenant_id);


--
-- Name: idx_tenant_identifications_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tenant_identifications_tenant ON public.tenant_identifications USING btree (tenant_id);


--
-- Name: idx_tenants_platform_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tenants_platform_status ON public.tenants USING btree (platform_status) WHERE (platform_status <> 'active'::text);


--
-- Name: idx_tenants_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tenants_user_id ON public.tenants USING btree (user_id);


--
-- Name: idx_unit_applications_landlord; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_unit_applications_landlord ON public.unit_applications USING btree (landlord_id);


--
-- Name: idx_unit_applications_unit; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_unit_applications_unit ON public.unit_applications USING btree (unit_id);


--
-- Name: idx_unit_bookings_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_unit_bookings_tenant ON public.unit_bookings USING btree (tenant_id);


--
-- Name: idx_unit_bookings_unit_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_unit_bookings_unit_date ON public.unit_bookings USING btree (unit_id, check_in, check_out);


--
-- Name: idx_unit_photos_unit; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_unit_photos_unit ON public.unit_photos USING btree (unit_id);


--
-- Name: idx_units_landlord; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_units_landlord ON public.units USING btree (landlord_id);


--
-- Name: idx_units_property; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_units_property ON public.units USING btree (property_id);


--
-- Name: idx_units_scheduled_activation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_units_scheduled_activation ON public.units USING btree (scheduled_activation_at) WHERE (scheduled_activation_at IS NOT NULL);


--
-- Name: idx_units_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_units_status ON public.units USING btree (status);


--
-- Name: idx_users_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_email ON public.users USING btree (email);


--
-- Name: idx_utility_meter_readings_billing_cycle; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_utility_meter_readings_billing_cycle ON public.utility_meter_readings USING btree (billing_cycle_month);


--
-- Name: idx_utility_meter_readings_meter_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_utility_meter_readings_meter_id ON public.utility_meter_readings USING btree (meter_id);


--
-- Name: idx_utility_meter_units_unit_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_utility_meter_units_unit_id ON public.utility_meter_units USING btree (unit_id);


--
-- Name: idx_utility_meters_property_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_utility_meters_property_id ON public.utility_meters USING btree (property_id);


--
-- Name: invitations_unique_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX invitations_unique_pending ON public.invitations USING btree (landlord_id, role, lower(email)) WHERE (status = 'pending'::text);


--
-- Name: lease_tenants_active_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX lease_tenants_active_unique ON public.lease_tenants USING btree (lease_id, tenant_id) WHERE (status = ANY (ARRAY['pending_add'::text, 'active'::text, 'pending_remove'::text]));


--
-- Name: lease_tenants_lease; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX lease_tenants_lease ON public.lease_tenants USING btree (lease_id);


--
-- Name: lease_tenants_primary_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX lease_tenants_primary_active ON public.lease_tenants USING btree (lease_id) WHERE ((role = 'primary'::text) AND (status = 'active'::text));


--
-- Name: lease_tenants_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX lease_tenants_status ON public.lease_tenants USING btree (status);


--
-- Name: lease_tenants_supersedes; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX lease_tenants_supersedes ON public.lease_tenants USING btree (supersedes_lease_tenant_id) WHERE (supersedes_lease_tenant_id IS NOT NULL);


--
-- Name: lease_tenants_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX lease_tenants_tenant ON public.lease_tenants USING btree (tenant_id);


--
-- Name: ux_invoices_landlord_number; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_invoices_landlord_number ON public.invoices USING btree (landlord_id, invoice_number);


--
-- Name: ux_invoices_lease_due_date; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_invoices_lease_due_date ON public.invoices USING btree (lease_id, due_date);


--
-- Name: ux_payments_fee_idempotent; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_payments_fee_idempotent ON public.payments USING btree (lease_fee_id, due_date) WHERE ((type = 'fee'::text) AND (status = ANY (ARRAY['pending'::text, 'processing'::text, 'settled'::text])));


--
-- Name: ux_payments_late_fee_idempotent; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_payments_late_fee_idempotent ON public.payments USING btree (invoice_id, due_date) WHERE ((type = 'late_fee'::text) AND (status = ANY (ARRAY['pending'::text, 'processing'::text, 'settled'::text])));


--
-- Name: ux_payments_rent_idempotent; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_payments_rent_idempotent ON public.payments USING btree (lease_id, due_date) WHERE ((type = 'rent'::text) AND (status = ANY (ARRAY['pending'::text, 'processing'::text, 'settled'::text])));


--
-- Name: security_deposits trg_deposits_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_deposits_updated_at BEFORE UPDATE ON public.security_deposits FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: emergency_contacts trg_emergency_contacts_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_emergency_contacts_updated_at BEFORE UPDATE ON public.emergency_contacts FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: invoices trg_invoices_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_invoices_updated_at BEFORE UPDATE ON public.invoices FOR EACH ROW EXECUTE FUNCTION public.fn_invoices_updated_at();


--
-- Name: landlords trg_landlords_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_landlords_updated_at BEFORE UPDATE ON public.landlords FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: lease_occupants trg_lease_occupants_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_lease_occupants_updated_at BEFORE UPDATE ON public.lease_occupants FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: lease_pets trg_lease_pets_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_lease_pets_updated_at BEFORE UPDATE ON public.lease_pets FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: lease_tenants trg_lease_tenants_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_lease_tenants_updated_at BEFORE UPDATE ON public.lease_tenants FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: lease_vehicles trg_lease_vehicles_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_lease_vehicles_updated_at BEFORE UPDATE ON public.lease_vehicles FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: leases trg_leases_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_leases_updated_at BEFORE UPDATE ON public.leases FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: liability_insurance_policies trg_liability_insurance_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_liability_insurance_updated_at BEFORE UPDATE ON public.liability_insurance_policies FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: maintenance_requests trg_maintenance_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_maintenance_updated_at BEFORE UPDATE ON public.maintenance_requests FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: mobile_homes trg_mobile_homes_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_mobile_homes_updated_at BEFORE UPDATE ON public.mobile_homes FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: payments trg_payments_invoice_late_fee_subtotal_rollup; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_payments_invoice_late_fee_subtotal_rollup AFTER INSERT OR DELETE OR UPDATE ON public.payments FOR EACH ROW EXECUTE FUNCTION public.fn_invoice_late_fee_subtotal_rollup_trigger();


--
-- Name: payments trg_payments_invoice_status_rollup; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_payments_invoice_status_rollup AFTER INSERT OR DELETE OR UPDATE OF status, invoice_id ON public.payments FOR EACH ROW EXECUTE FUNCTION public.fn_invoice_status_rollup();


--
-- Name: properties trg_properties_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_properties_updated_at BEFORE UPDATE ON public.properties FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: rvs trg_rvs_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_rvs_updated_at BEFORE UPDATE ON public.rvs FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: subleases trg_subleases_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_subleases_updated_at BEFORE UPDATE ON public.subleases FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: tenant_identifications trg_tenant_identifications_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_tenant_identifications_updated_at BEFORE UPDATE ON public.tenant_identifications FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: tenants trg_tenants_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_tenants_updated_at BEFORE UPDATE ON public.tenants FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: units trg_units_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_units_updated_at BEFORE UPDATE ON public.units FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: users trg_users_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: ach_monitoring_log ach_monitoring_log_payment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ach_monitoring_log
    ADD CONSTRAINT ach_monitoring_log_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES public.payments(id);


--
-- Name: ach_monitoring_log ach_monitoring_log_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ach_monitoring_log
    ADD CONSTRAINT ach_monitoring_log_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: audit_log audit_log_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: background_checks background_checks_landlord_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.background_checks
    ADD CONSTRAINT background_checks_landlord_id_fkey FOREIGN KEY (landlord_id) REFERENCES public.landlords(id);


--
-- Name: background_checks background_checks_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.background_checks
    ADD CONSTRAINT background_checks_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES public.units(id);


--
-- Name: bank_reconciliations bank_reconciliations_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bank_reconciliations
    ADD CONSTRAINT bank_reconciliations_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.books_accounts(id);


--
-- Name: bank_reconciliations bank_reconciliations_landlord_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bank_reconciliations
    ADD CONSTRAINT bank_reconciliations_landlord_id_fkey FOREIGN KEY (landlord_id) REFERENCES public.landlords(id) ON DELETE CASCADE;


--
-- Name: bookkeeper_scopes bookkeeper_scopes_landlord_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookkeeper_scopes
    ADD CONSTRAINT bookkeeper_scopes_landlord_id_fkey FOREIGN KEY (landlord_id) REFERENCES public.landlords(id) ON DELETE CASCADE;


--
-- Name: bookkeeper_scopes bookkeeper_scopes_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookkeeper_scopes
    ADD CONSTRAINT bookkeeper_scopes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: books_accounts books_accounts_landlord_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.books_accounts
    ADD CONSTRAINT books_accounts_landlord_id_fkey FOREIGN KEY (landlord_id) REFERENCES public.landlords(id) ON DELETE CASCADE;


--
-- Name: books_bills books_bills_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.books_bills
    ADD CONSTRAINT books_bills_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.books_accounts(id);


--
-- Name: books_bills books_bills_landlord_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.books_bills
    ADD CONSTRAINT books_bills_landlord_id_fkey FOREIGN KEY (landlord_id) REFERENCES public.landlords(id) ON DELETE CASCADE;


--
-- Name: books_bills books_bills_vendor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.books_bills
    ADD CONSTRAINT books_bills_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES public.books_vendors(id);


--
-- Name: books_contractors books_contractors_landlord_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.books_contractors
    ADD CONSTRAINT books_contractors_landlord_id_fkey FOREIGN KEY (landlord_id) REFERENCES public.landlords(id) ON DELETE CASCADE;


--
-- Name: books_employees books_employees_landlord_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.books_employees
    ADD CONSTRAINT books_employees_landlord_id_fkey FOREIGN KEY (landlord_id) REFERENCES public.landlords(id) ON DELETE CASCADE;


--
-- Name: books_transactions books_transactions_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.books_transactions
    ADD CONSTRAINT books_transactions_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.books_accounts(id);


--
-- Name: books_transactions books_transactions_landlord_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.books_transactions
    ADD CONSTRAINT books_transactions_landlord_id_fkey FOREIGN KEY (landlord_id) REFERENCES public.landlords(id) ON DELETE CASCADE;


--
-- Name: books_vendors books_vendors_landlord_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.books_vendors
    ADD CONSTRAINT books_vendors_landlord_id_fkey FOREIGN KEY (landlord_id) REFERENCES public.landlords(id) ON DELETE CASCADE;


--
-- Name: bulletin_posts bulletin_posts_property_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bulletin_posts
    ADD CONSTRAINT bulletin_posts_property_id_fkey FOREIGN KEY (property_id) REFERENCES public.properties(id) ON DELETE CASCADE;


--
-- Name: bulletin_posts bulletin_posts_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bulletin_posts
    ADD CONSTRAINT bulletin_posts_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: bulletin_reveal_log bulletin_reveal_log_post_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bulletin_reveal_log
    ADD CONSTRAINT bulletin_reveal_log_post_id_fkey FOREIGN KEY (post_id) REFERENCES public.bulletin_posts(id) ON DELETE CASCADE;


--
-- Name: bulletin_votes bulletin_votes_post_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bulletin_votes
    ADD CONSTRAINT bulletin_votes_post_id_fkey FOREIGN KEY (post_id) REFERENCES public.bulletin_posts(id) ON DELETE CASCADE;


--
-- Name: bulletin_votes bulletin_votes_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bulletin_votes
    ADD CONSTRAINT bulletin_votes_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: disbursements disbursements_landlord_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.disbursements
    ADD CONSTRAINT disbursements_landlord_id_fkey FOREIGN KEY (landlord_id) REFERENCES public.landlords(id);


--
-- Name: document_batches document_batches_landlord_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_batches
    ADD CONSTRAINT document_batches_landlord_id_fkey FOREIGN KEY (landlord_id) REFERENCES public.landlords(id) ON DELETE CASCADE;


--
-- Name: document_batches document_batches_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_batches
    ADD CONSTRAINT document_batches_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.lease_templates(id) ON DELETE RESTRICT;


--
-- Name: document_batches document_batches_voided_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_batches
    ADD CONSTRAINT document_batches_voided_by_fkey FOREIGN KEY (voided_by) REFERENCES public.users(id);


--
-- Name: documents documents_landlord_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_landlord_id_fkey FOREIGN KEY (landlord_id) REFERENCES public.landlords(id);


--
-- Name: documents documents_lease_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_lease_id_fkey FOREIGN KEY (lease_id) REFERENCES public.leases(id);


--
-- Name: documents documents_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: documents documents_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES public.units(id);


--
-- Name: emergency_contacts emergency_contacts_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.emergency_contacts
    ADD CONSTRAINT emergency_contacts_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: fitness_body_weight_logs fitness_body_weight_logs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fitness_body_weight_logs
    ADD CONSTRAINT fitness_body_weight_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: fitness_days fitness_days_routine_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fitness_days
    ADD CONSTRAINT fitness_days_routine_id_fkey FOREIGN KEY (routine_id) REFERENCES public.fitness_routines(id) ON DELETE CASCADE;


--
-- Name: fitness_exercises fitness_exercises_section_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fitness_exercises
    ADD CONSTRAINT fitness_exercises_section_id_fkey FOREIGN KEY (section_id) REFERENCES public.fitness_sections(id) ON DELETE CASCADE;


--
-- Name: fitness_milestones fitness_milestones_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fitness_milestones
    ADD CONSTRAINT fitness_milestones_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: fitness_profiles fitness_profiles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fitness_profiles
    ADD CONSTRAINT fitness_profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: fitness_routines fitness_routines_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fitness_routines
    ADD CONSTRAINT fitness_routines_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: fitness_sections fitness_sections_day_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fitness_sections
    ADD CONSTRAINT fitness_sections_day_id_fkey FOREIGN KEY (day_id) REFERENCES public.fitness_days(id) ON DELETE CASCADE;


--
-- Name: fitness_set_logs fitness_set_logs_exercise_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fitness_set_logs
    ADD CONSTRAINT fitness_set_logs_exercise_id_fkey FOREIGN KEY (exercise_id) REFERENCES public.fitness_exercises(id) ON DELETE SET NULL;


--
-- Name: fitness_set_logs fitness_set_logs_log_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fitness_set_logs
    ADD CONSTRAINT fitness_set_logs_log_id_fkey FOREIGN KEY (log_id) REFERENCES public.fitness_workout_logs(id) ON DELETE CASCADE;


--
-- Name: fitness_set_logs fitness_set_logs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fitness_set_logs
    ADD CONSTRAINT fitness_set_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: fitness_workout_logs fitness_workout_logs_day_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fitness_workout_logs
    ADD CONSTRAINT fitness_workout_logs_day_id_fkey FOREIGN KEY (day_id) REFERENCES public.fitness_days(id) ON DELETE SET NULL;


--
-- Name: fitness_workout_logs fitness_workout_logs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fitness_workout_logs
    ADD CONSTRAINT fitness_workout_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: invitations invitations_accepted_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invitations
    ADD CONSTRAINT invitations_accepted_user_id_fkey FOREIGN KEY (accepted_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: invitations invitations_invited_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invitations
    ADD CONSTRAINT invitations_invited_by_user_id_fkey FOREIGN KEY (invited_by_user_id) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: invitations invitations_landlord_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invitations
    ADD CONSTRAINT invitations_landlord_id_fkey FOREIGN KEY (landlord_id) REFERENCES public.landlords(id) ON DELETE CASCADE;


--
-- Name: invitations invitations_revoked_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invitations
    ADD CONSTRAINT invitations_revoked_by_user_id_fkey FOREIGN KEY (revoked_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: invoice_sequences invoice_sequences_landlord_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_sequences
    ADD CONSTRAINT invoice_sequences_landlord_id_fkey FOREIGN KEY (landlord_id) REFERENCES public.landlords(id) ON DELETE CASCADE;


--
-- Name: invoices invoices_landlord_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_landlord_id_fkey FOREIGN KEY (landlord_id) REFERENCES public.landlords(id) ON DELETE RESTRICT;


--
-- Name: invoices invoices_lease_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_lease_id_fkey FOREIGN KEY (lease_id) REFERENCES public.leases(id) ON DELETE RESTRICT;


--
-- Name: invoices invoices_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE SET NULL;


--
-- Name: invoices invoices_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES public.units(id) ON DELETE RESTRICT;


--
-- Name: journal_entries journal_entries_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journal_entries
    ADD CONSTRAINT journal_entries_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: journal_entries journal_entries_landlord_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journal_entries
    ADD CONSTRAINT journal_entries_landlord_id_fkey FOREIGN KEY (landlord_id) REFERENCES public.landlords(id) ON DELETE CASCADE;


--
-- Name: journal_entry_lines journal_entry_lines_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journal_entry_lines
    ADD CONSTRAINT journal_entry_lines_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.books_accounts(id);


--
-- Name: journal_entry_lines journal_entry_lines_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journal_entry_lines
    ADD CONSTRAINT journal_entry_lines_entry_id_fkey FOREIGN KEY (entry_id) REFERENCES public.journal_entries(id) ON DELETE CASCADE;


--
-- Name: landlords landlords_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.landlords
    ADD CONSTRAINT landlords_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: lease_document_fields lease_document_fields_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lease_document_fields
    ADD CONSTRAINT lease_document_fields_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.lease_documents(id) ON DELETE CASCADE;


--
-- Name: lease_document_fields lease_document_fields_signer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lease_document_fields
    ADD CONSTRAINT lease_document_fields_signer_id_fkey FOREIGN KEY (signer_id) REFERENCES public.lease_document_signers(id) ON DELETE SET NULL;


--
-- Name: lease_document_fields lease_document_fields_template_field_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lease_document_fields
    ADD CONSTRAINT lease_document_fields_template_field_id_fkey FOREIGN KEY (template_field_id) REFERENCES public.lease_template_fields(id) ON DELETE SET NULL;


--
-- Name: lease_document_signers lease_document_signers_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lease_document_signers
    ADD CONSTRAINT lease_document_signers_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.lease_documents(id) ON DELETE CASCADE;


--
-- Name: lease_document_signers lease_document_signers_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lease_document_signers
    ADD CONSTRAINT lease_document_signers_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: lease_documents lease_documents_batch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lease_documents
    ADD CONSTRAINT lease_documents_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES public.document_batches(id) ON DELETE SET NULL;


--
-- Name: lease_documents lease_documents_landlord_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lease_documents
    ADD CONSTRAINT lease_documents_landlord_id_fkey FOREIGN KEY (landlord_id) REFERENCES public.landlords(id) ON DELETE CASCADE;


--
-- Name: lease_documents lease_documents_lease_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lease_documents
    ADD CONSTRAINT lease_documents_lease_id_fkey FOREIGN KEY (lease_id) REFERENCES public.leases(id) ON DELETE SET NULL;


--
-- Name: lease_documents lease_documents_promote_lease_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lease_documents
    ADD CONSTRAINT lease_documents_promote_lease_tenant_id_fkey FOREIGN KEY (promote_lease_tenant_id) REFERENCES public.lease_tenants(id) ON DELETE SET NULL;


--
-- Name: lease_documents lease_documents_target_lease_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lease_documents
    ADD CONSTRAINT lease_documents_target_lease_tenant_id_fkey FOREIGN KEY (target_lease_tenant_id) REFERENCES public.lease_tenants(id) ON DELETE SET NULL;


--
-- Name: lease_documents lease_documents_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lease_documents
    ADD CONSTRAINT lease_documents_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.lease_templates(id) ON DELETE SET NULL;


--
-- Name: lease_documents lease_documents_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lease_documents
    ADD CONSTRAINT lease_documents_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES public.units(id) ON DELETE SET NULL;


--
-- Name: lease_fees lease_fees_lease_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lease_fees
    ADD CONSTRAINT lease_fees_lease_id_fkey FOREIGN KEY (lease_id) REFERENCES public.leases(id) ON DELETE CASCADE;


--
-- Name: lease_occupants lease_occupants_background_check_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lease_occupants
    ADD CONSTRAINT lease_occupants_background_check_id_fkey FOREIGN KEY (background_check_id) REFERENCES public.background_checks(id) ON DELETE SET NULL;


--
-- Name: lease_occupants lease_occupants_lease_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lease_occupants
    ADD CONSTRAINT lease_occupants_lease_id_fkey FOREIGN KEY (lease_id) REFERENCES public.leases(id) ON DELETE CASCADE;


--
-- Name: lease_pets lease_pets_lease_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lease_pets
    ADD CONSTRAINT lease_pets_lease_id_fkey FOREIGN KEY (lease_id) REFERENCES public.leases(id) ON DELETE CASCADE;


--
-- Name: lease_template_fields lease_template_fields_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lease_template_fields
    ADD CONSTRAINT lease_template_fields_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.lease_templates(id) ON DELETE CASCADE;


--
-- Name: lease_templates lease_templates_landlord_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lease_templates
    ADD CONSTRAINT lease_templates_landlord_id_fkey FOREIGN KEY (landlord_id) REFERENCES public.landlords(id) ON DELETE CASCADE;


--
-- Name: lease_tenants lease_tenants_add_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lease_tenants
    ADD CONSTRAINT lease_tenants_add_document_id_fkey FOREIGN KEY (add_document_id) REFERENCES public.lease_documents(id);


--
-- Name: lease_tenants lease_tenants_lease_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lease_tenants
    ADD CONSTRAINT lease_tenants_lease_id_fkey FOREIGN KEY (lease_id) REFERENCES public.leases(id) ON DELETE CASCADE;


--
-- Name: lease_tenants lease_tenants_remove_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lease_tenants
    ADD CONSTRAINT lease_tenants_remove_document_id_fkey FOREIGN KEY (remove_document_id) REFERENCES public.lease_documents(id);


--
-- Name: lease_tenants lease_tenants_supersedes_lease_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lease_tenants
    ADD CONSTRAINT lease_tenants_supersedes_lease_tenant_id_fkey FOREIGN KEY (supersedes_lease_tenant_id) REFERENCES public.lease_tenants(id) ON DELETE SET NULL;


--
-- Name: lease_tenants lease_tenants_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lease_tenants
    ADD CONSTRAINT lease_tenants_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: lease_utility_assignments lease_utility_assignments_lease_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lease_utility_assignments
    ADD CONSTRAINT lease_utility_assignments_lease_id_fkey FOREIGN KEY (lease_id) REFERENCES public.leases(id) ON DELETE CASCADE;


--
-- Name: lease_utility_assignments lease_utility_assignments_meter_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lease_utility_assignments
    ADD CONSTRAINT lease_utility_assignments_meter_id_fkey FOREIGN KEY (meter_id) REFERENCES public.utility_meters(id) ON DELETE CASCADE;


--
-- Name: lease_utility_responsibilities lease_utility_responsibilities_lease_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lease_utility_responsibilities
    ADD CONSTRAINT lease_utility_responsibilities_lease_id_fkey FOREIGN KEY (lease_id) REFERENCES public.leases(id) ON DELETE CASCADE;


--
-- Name: lease_vehicles lease_vehicles_lease_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lease_vehicles
    ADD CONSTRAINT lease_vehicles_lease_id_fkey FOREIGN KEY (lease_id) REFERENCES public.leases(id) ON DELETE CASCADE;


--
-- Name: lease_vehicles lease_vehicles_owner_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lease_vehicles
    ADD CONSTRAINT lease_vehicles_owner_tenant_id_fkey FOREIGN KEY (owner_tenant_id) REFERENCES public.tenants(id) ON DELETE SET NULL;


--
-- Name: leases leases_landlord_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leases
    ADD CONSTRAINT leases_landlord_id_fkey FOREIGN KEY (landlord_id) REFERENCES public.landlords(id);


--
-- Name: leases leases_supersedes_lease_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leases
    ADD CONSTRAINT leases_supersedes_lease_id_fkey FOREIGN KEY (supersedes_lease_id) REFERENCES public.leases(id);


--
-- Name: leases leases_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leases
    ADD CONSTRAINT leases_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES public.units(id);


--
-- Name: liability_insurance_policies liability_insurance_policies_lease_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.liability_insurance_policies
    ADD CONSTRAINT liability_insurance_policies_lease_id_fkey FOREIGN KEY (lease_id) REFERENCES public.leases(id) ON DELETE CASCADE;


--
-- Name: maintenance_comments maintenance_comments_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_comments
    ADD CONSTRAINT maintenance_comments_request_id_fkey FOREIGN KEY (request_id) REFERENCES public.maintenance_requests(id) ON DELETE CASCADE;


--
-- Name: maintenance_comments maintenance_comments_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_comments
    ADD CONSTRAINT maintenance_comments_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: maintenance_requests maintenance_requests_contractor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_requests
    ADD CONSTRAINT maintenance_requests_contractor_id_fkey FOREIGN KEY (contractor_id) REFERENCES public.contractors(id);


--
-- Name: maintenance_requests maintenance_requests_landlord_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_requests
    ADD CONSTRAINT maintenance_requests_landlord_id_fkey FOREIGN KEY (landlord_id) REFERENCES public.landlords(id);


--
-- Name: maintenance_requests maintenance_requests_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_requests
    ADD CONSTRAINT maintenance_requests_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: maintenance_requests maintenance_requests_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_requests
    ADD CONSTRAINT maintenance_requests_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES public.units(id);


--
-- Name: maintenance_worker_scopes maintenance_worker_scopes_landlord_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_worker_scopes
    ADD CONSTRAINT maintenance_worker_scopes_landlord_id_fkey FOREIGN KEY (landlord_id) REFERENCES public.landlords(id) ON DELETE CASCADE;


--
-- Name: maintenance_worker_scopes maintenance_worker_scopes_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_worker_scopes
    ADD CONSTRAINT maintenance_worker_scopes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: mobile_homes mobile_homes_current_owner_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mobile_homes
    ADD CONSTRAINT mobile_homes_current_owner_tenant_id_fkey FOREIGN KEY (current_owner_tenant_id) REFERENCES public.tenants(id) ON DELETE SET NULL;


--
-- Name: mobile_homes mobile_homes_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mobile_homes
    ADD CONSTRAINT mobile_homes_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES public.units(id) ON DELETE SET NULL;


--
-- Name: notifications notifications_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: onsite_manager_scopes onsite_manager_scopes_landlord_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.onsite_manager_scopes
    ADD CONSTRAINT onsite_manager_scopes_landlord_id_fkey FOREIGN KEY (landlord_id) REFERENCES public.landlords(id) ON DELETE CASCADE;


--
-- Name: onsite_manager_scopes onsite_manager_scopes_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.onsite_manager_scopes
    ADD CONSTRAINT onsite_manager_scopes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: payments payments_invoice_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES public.invoices(id) ON DELETE RESTRICT;


--
-- Name: payments payments_landlord_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_landlord_id_fkey FOREIGN KEY (landlord_id) REFERENCES public.landlords(id);


--
-- Name: payments payments_lease_fee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_lease_fee_id_fkey FOREIGN KEY (lease_fee_id) REFERENCES public.lease_fees(id) ON DELETE SET NULL;


--
-- Name: payments payments_lease_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_lease_id_fkey FOREIGN KEY (lease_id) REFERENCES public.leases(id);


--
-- Name: payments payments_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: payments payments_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES public.units(id);


--
-- Name: payroll_run_lines payroll_run_lines_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_run_lines
    ADD CONSTRAINT payroll_run_lines_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.books_employees(id);


--
-- Name: payroll_run_lines payroll_run_lines_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_run_lines
    ADD CONSTRAINT payroll_run_lines_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.payroll_runs(id) ON DELETE CASCADE;


--
-- Name: payroll_runs payroll_runs_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_runs
    ADD CONSTRAINT payroll_runs_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(id);


--
-- Name: payroll_runs payroll_runs_landlord_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_runs
    ADD CONSTRAINT payroll_runs_landlord_id_fkey FOREIGN KEY (landlord_id) REFERENCES public.landlords(id) ON DELETE CASCADE;


--
-- Name: pending_tenant_intents pending_tenant_intents_landlord_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pending_tenant_intents
    ADD CONSTRAINT pending_tenant_intents_landlord_id_fkey FOREIGN KEY (landlord_id) REFERENCES public.landlords(id) ON DELETE CASCADE;


--
-- Name: pending_tenant_intents pending_tenant_intents_resolved_lease_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pending_tenant_intents
    ADD CONSTRAINT pending_tenant_intents_resolved_lease_id_fkey FOREIGN KEY (resolved_lease_id) REFERENCES public.leases(id) ON DELETE SET NULL;


--
-- Name: pending_tenant_intents pending_tenant_intents_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pending_tenant_intents
    ADD CONSTRAINT pending_tenant_intents_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: platform_events platform_events_actor_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_events
    ADD CONSTRAINT platform_events_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: properties properties_landlord_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.properties
    ADD CONSTRAINT properties_landlord_id_fkey FOREIGN KEY (landlord_id) REFERENCES public.landlords(id) ON DELETE CASCADE;


--
-- Name: property_duplicate_flags property_duplicate_flags_conflicting_property_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.property_duplicate_flags
    ADD CONSTRAINT property_duplicate_flags_conflicting_property_id_fkey FOREIGN KEY (conflicting_property_id) REFERENCES public.properties(id) ON DELETE CASCADE;


--
-- Name: property_duplicate_flags property_duplicate_flags_property_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.property_duplicate_flags
    ADD CONSTRAINT property_duplicate_flags_property_id_fkey FOREIGN KEY (property_id) REFERENCES public.properties(id) ON DELETE CASCADE;


--
-- Name: property_duplicate_flags property_duplicate_flags_resolved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.property_duplicate_flags
    ADD CONSTRAINT property_duplicate_flags_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES public.users(id);


--
-- Name: property_manager_scopes property_manager_scopes_landlord_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.property_manager_scopes
    ADD CONSTRAINT property_manager_scopes_landlord_id_fkey FOREIGN KEY (landlord_id) REFERENCES public.landlords(id) ON DELETE CASCADE;


--
-- Name: property_manager_scopes property_manager_scopes_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.property_manager_scopes
    ADD CONSTRAINT property_manager_scopes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: rvs rvs_current_owner_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rvs
    ADD CONSTRAINT rvs_current_owner_tenant_id_fkey FOREIGN KEY (current_owner_tenant_id) REFERENCES public.tenants(id) ON DELETE SET NULL;


--
-- Name: rvs rvs_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rvs
    ADD CONSTRAINT rvs_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES public.units(id) ON DELETE SET NULL;


--
-- Name: security_deposits security_deposits_lease_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.security_deposits
    ADD CONSTRAINT security_deposits_lease_id_fkey FOREIGN KEY (lease_id) REFERENCES public.leases(id);


--
-- Name: security_deposits security_deposits_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.security_deposits
    ADD CONSTRAINT security_deposits_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: security_deposits security_deposits_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.security_deposits
    ADD CONSTRAINT security_deposits_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES public.units(id);


--
-- Name: subleases subleases_master_lease_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subleases
    ADD CONSTRAINT subleases_master_lease_id_fkey FOREIGN KEY (master_lease_id) REFERENCES public.leases(id) ON DELETE RESTRICT;


--
-- Name: subleases subleases_sublessee_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subleases
    ADD CONSTRAINT subleases_sublessee_tenant_id_fkey FOREIGN KEY (sublessee_tenant_id) REFERENCES public.tenants(id);


--
-- Name: subleases subleases_sublessor_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subleases
    ADD CONSTRAINT subleases_sublessor_tenant_id_fkey FOREIGN KEY (sublessor_tenant_id) REFERENCES public.tenants(id);


--
-- Name: team_members team_members_landlord_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_members
    ADD CONSTRAINT team_members_landlord_id_fkey FOREIGN KEY (landlord_id) REFERENCES public.landlords(id) ON DELETE CASCADE;


--
-- Name: team_members team_members_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_members
    ADD CONSTRAINT team_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: tenant_identifications tenant_identifications_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_identifications
    ADD CONSTRAINT tenant_identifications_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: tenant_identifications tenant_identifications_verified_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_identifications
    ADD CONSTRAINT tenant_identifications_verified_by_fkey FOREIGN KEY (verified_by) REFERENCES public.users(id);


--
-- Name: tenants tenants_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenants
    ADD CONSTRAINT tenants_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: unit_applications unit_applications_landlord_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.unit_applications
    ADD CONSTRAINT unit_applications_landlord_id_fkey FOREIGN KEY (landlord_id) REFERENCES public.landlords(id) ON DELETE SET NULL;


--
-- Name: unit_applications unit_applications_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.unit_applications
    ADD CONSTRAINT unit_applications_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES public.units(id) ON DELETE SET NULL;


--
-- Name: unit_bookings unit_bookings_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.unit_bookings
    ADD CONSTRAINT unit_bookings_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE SET NULL;


--
-- Name: unit_bookings unit_bookings_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.unit_bookings
    ADD CONSTRAINT unit_bookings_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES public.units(id) ON DELETE CASCADE;


--
-- Name: unit_photos unit_photos_landlord_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.unit_photos
    ADD CONSTRAINT unit_photos_landlord_id_fkey FOREIGN KEY (landlord_id) REFERENCES public.landlords(id) ON DELETE CASCADE;


--
-- Name: unit_photos unit_photos_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.unit_photos
    ADD CONSTRAINT unit_photos_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES public.units(id) ON DELETE CASCADE;


--
-- Name: units units_landlord_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.units
    ADD CONSTRAINT units_landlord_id_fkey FOREIGN KEY (landlord_id) REFERENCES public.landlords(id);


--
-- Name: units units_payment_block_set_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.units
    ADD CONSTRAINT units_payment_block_set_by_fkey FOREIGN KEY (payment_block_set_by) REFERENCES public.users(id);


--
-- Name: units units_property_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.units
    ADD CONSTRAINT units_property_id_fkey FOREIGN KEY (property_id) REFERENCES public.properties(id) ON DELETE CASCADE;


--
-- Name: units units_scheduled_activation_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.units
    ADD CONSTRAINT units_scheduled_activation_by_fkey FOREIGN KEY (scheduled_activation_by) REFERENCES public.users(id);


--
-- Name: utility_meter_readings utility_meter_readings_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.utility_meter_readings
    ADD CONSTRAINT utility_meter_readings_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.users(id);


--
-- Name: utility_meter_readings utility_meter_readings_meter_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.utility_meter_readings
    ADD CONSTRAINT utility_meter_readings_meter_id_fkey FOREIGN KEY (meter_id) REFERENCES public.utility_meters(id) ON DELETE CASCADE;


--
-- Name: utility_meter_units utility_meter_units_meter_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.utility_meter_units
    ADD CONSTRAINT utility_meter_units_meter_id_fkey FOREIGN KEY (meter_id) REFERENCES public.utility_meters(id) ON DELETE CASCADE;


--
-- Name: utility_meter_units utility_meter_units_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.utility_meter_units
    ADD CONSTRAINT utility_meter_units_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES public.units(id) ON DELETE CASCADE;


--
-- Name: utility_meters utility_meters_property_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.utility_meters
    ADD CONSTRAINT utility_meters_property_id_fkey FOREIGN KEY (property_id) REFERENCES public.properties(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--


