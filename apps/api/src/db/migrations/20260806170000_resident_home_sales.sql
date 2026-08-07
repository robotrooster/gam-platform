-- Resident-to-resident home sale (S594, Nic — the "between two tenants" case).
--
-- WHY: a resident who OWNS their home/RV (tracked in home_ownerships) may sell
-- it to another resident on payments. Nic's absolute rule: GAM does NOT process
-- or route that money — it's strictly between the two residents. GAM only keeps
-- a RECORD: the agreed schedule + a copy of the signed contract on file for the
-- landlord, and — when the parties mark it paid off — flips the home-ownership
-- record to the buyer.
--
-- This is deliberately a SEPARATE table from home_sale_contracts (the
-- landlord→tenant sale that GAM DOES bill). Keeping them apart means the
-- home-sale billing cron (which reads home_sale_contracts) can never pick up a
-- resident sale — the money distinction is enforced by the schema, not by a
-- flag a future query might forget.
--
-- SAFE: brand-new tables; no backfill.

CREATE TABLE public.resident_home_sales (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    unit_id uuid NOT NULL,
    property_id uuid NOT NULL,
    landlord_id uuid NOT NULL,
    seller_user_id uuid NOT NULL,
    buyer_user_id uuid NOT NULL,
    plan_type text DEFAULT 'flat'::text NOT NULL,
    sale_price numeric(12,2) NOT NULL,
    down_payment numeric(12,2) DEFAULT 0 NOT NULL,
    annual_interest_rate numeric(6,3) DEFAULT 0 NOT NULL,
    term_months integer NOT NULL,
    monthly_payment numeric(12,2) NOT NULL,
    start_month date NOT NULL,
    installments_total integer NOT NULL,
    installments_paid integer DEFAULT 0 NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    contract_document_id uuid,
    notes text,
    created_by_user_id uuid,
    paid_off_at timestamp with time zone,
    cancelled_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT resident_home_sales_pkey PRIMARY KEY (id),
    CONSTRAINT resident_home_sales_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES public.units(id),
    CONSTRAINT resident_home_sales_seller_fkey FOREIGN KEY (seller_user_id) REFERENCES public.users(id),
    CONSTRAINT resident_home_sales_buyer_fkey FOREIGN KEY (buyer_user_id) REFERENCES public.users(id),
    CONSTRAINT resident_home_sales_contract_doc_fkey FOREIGN KEY (contract_document_id) REFERENCES public.documents(id),
    CONSTRAINT resident_home_sales_plan_type_check CHECK ((plan_type = ANY (ARRAY['amortized'::text, 'flat'::text]))),
    CONSTRAINT resident_home_sales_status_check CHECK ((status = ANY (ARRAY['active'::text, 'paid_off'::text, 'cancelled'::text]))),
    CONSTRAINT resident_home_sales_sale_price_check CHECK ((sale_price > (0)::numeric)),
    CONSTRAINT resident_home_sales_term_check CHECK (((term_months > 0) AND (term_months <= 600))),
    CONSTRAINT resident_home_sales_parties_distinct CHECK ((seller_user_id <> buyer_user_id))
);

COMMENT ON TABLE public.resident_home_sales IS 'S594: resident-to-resident financed home sale. GAM records the schedule + holds the contract; it moves NO money (that is strictly between the two residents). Separate from home_sale_contracts on purpose so billing can never touch it.';

-- One active resident sale per unit (mirrors ux_home_sale_active_per_unit).
CREATE UNIQUE INDEX ux_resident_home_sale_active_per_unit ON public.resident_home_sales USING btree (unit_id) WHERE (status = 'active'::text);
CREATE INDEX idx_resident_home_sales_unit ON public.resident_home_sales USING btree (unit_id);
CREATE INDEX idx_resident_home_sales_buyer ON public.resident_home_sales USING btree (buyer_user_id) WHERE (status = 'active'::text);

CREATE TABLE public.resident_home_sale_installments (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    sale_id uuid NOT NULL,
    installment_number integer NOT NULL,
    due_month date NOT NULL,
    amount numeric(12,2) NOT NULL,
    principal_portion numeric(12,2) NOT NULL,
    interest_portion numeric(12,2) NOT NULL,
    remaining_balance numeric(12,2) NOT NULL,
    paid boolean DEFAULT false NOT NULL,
    paid_at timestamp with time zone,
    paid_recorded_by_user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT resident_home_sale_installments_pkey PRIMARY KEY (id),
    CONSTRAINT resident_home_sale_installments_uq UNIQUE (sale_id, installment_number),
    CONSTRAINT resident_home_sale_installments_sale_fkey FOREIGN KEY (sale_id) REFERENCES public.resident_home_sales(id) ON DELETE CASCADE
);

COMMENT ON COLUMN public.resident_home_sale_installments.paid IS 'S594: manual paid flag — the landlord records that the resident buyer paid the resident seller off-platform. GAM moves no money; there is no payment_id.';

CREATE INDEX idx_resident_home_sale_installments_sale ON public.resident_home_sale_installments USING btree (sale_id);

CREATE TRIGGER trg_resident_home_sales_updated_at BEFORE UPDATE ON public.resident_home_sales FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
