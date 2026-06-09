-- S263: POS multi-terminal session sync — v1 (server-of-record cart state).
--
-- Adds `pos_sessions` + `pos_session_items` to back the live cart on the
-- POS terminal with server state instead of client-side useState. Lets
-- one terminal start a cart and another terminal pick it up
-- (cross-terminal tab), survives terminal crash / browser refresh
-- (crash recovery), and is the foundation for future offline tolerance
-- (Session 2) and SSE realtime push (Session 3).
--
-- Session lifecycle:
--   open      → cart actively being edited
--   completed → checked out via /pos/sessions/:id/checkout, which
--               also inserts a pos_transactions row + items. The
--               session row stays in 'completed' status as an audit
--               trail link via completed_transaction_id.
--   voided    → abandoned. void_reason captures why (manual cancel,
--               stale timeout, etc.).
--
-- Scoped by property_id (NOT just landlord_id) — POS items are
-- per-property since S241, so sessions inherit that scope. The
-- open-tabs list query filters `(property_id, status='open')`.

CREATE TABLE public.pos_sessions (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL PRIMARY KEY,
    property_id uuid NOT NULL,
    landlord_id uuid NOT NULL,
    opened_by_user_id uuid NOT NULL,
    pos_customer_id uuid,
    tenant_id uuid,
    status text NOT NULL DEFAULT 'open',
    subtotal numeric(10,2) NOT NULL DEFAULT 0,
    tax_amount numeric(10,2) NOT NULL DEFAULT 0,
    discount_amount numeric(10,2) NOT NULL DEFAULT 0,
    total numeric(10,2) NOT NULL DEFAULT 0,
    notes text,
    opened_at timestamp with time zone NOT NULL DEFAULT now(),
    closed_at timestamp with time zone,
    completed_transaction_id uuid,
    void_reason text,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT pos_sessions_status_check CHECK ((status = ANY (ARRAY['open'::text, 'completed'::text, 'voided'::text]))),
    CONSTRAINT pos_sessions_amounts_nonneg CHECK ((subtotal >= 0 AND tax_amount >= 0 AND discount_amount >= 0 AND total >= 0)),
    CONSTRAINT pos_sessions_customer_xor CHECK (NOT (pos_customer_id IS NOT NULL AND tenant_id IS NOT NULL))
);

COMMENT ON TABLE public.pos_sessions IS
    'S263: server-of-record cart state for POS terminals. Replaces the client-side useState cart on apps/pos.';
COMMENT ON COLUMN public.pos_sessions.completed_transaction_id IS
    'S263: FK to pos_transactions.id once /checkout fires. NULL while open.';
COMMENT ON COLUMN public.pos_sessions.pos_customer_id IS
    'S263: optional FK to pos_customers.id when the session is for a known POS customer.';
COMMENT ON COLUMN public.pos_sessions.tenant_id IS
    'S263: optional FK to tenants.id when the session is for a tenant (e.g., FlexCharge tab).';

ALTER TABLE public.pos_sessions
    ADD CONSTRAINT pos_sessions_property_id_fkey FOREIGN KEY (property_id) REFERENCES public.properties(id),
    ADD CONSTRAINT pos_sessions_landlord_id_fkey FOREIGN KEY (landlord_id) REFERENCES public.landlords(id),
    ADD CONSTRAINT pos_sessions_opened_by_user_id_fkey FOREIGN KEY (opened_by_user_id) REFERENCES public.users(id),
    ADD CONSTRAINT pos_sessions_pos_customer_id_fkey FOREIGN KEY (pos_customer_id) REFERENCES public.pos_customers(id),
    ADD CONSTRAINT pos_sessions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id),
    ADD CONSTRAINT pos_sessions_completed_transaction_id_fkey FOREIGN KEY (completed_transaction_id) REFERENCES public.pos_transactions(id);

-- Open-tabs list query — fetches active sessions for a property. The
-- partial index keeps it tight (closed sessions are the majority over time).
CREATE INDEX pos_sessions_property_open_idx
    ON public.pos_sessions (property_id, opened_at DESC)
    WHERE status = 'open';

CREATE INDEX pos_sessions_landlord_status_idx
    ON public.pos_sessions (landlord_id, status, opened_at DESC);


CREATE TABLE public.pos_session_items (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL PRIMARY KEY,
    session_id uuid NOT NULL,
    item_id uuid,
    item_variant_id uuid,
    item_name text NOT NULL,
    item_category text,
    qty numeric(10,3) NOT NULL,
    unit_price numeric(10,2) NOT NULL,
    cost_price numeric(10,2) NOT NULL DEFAULT 0,
    tax_rate numeric(5,4) NOT NULL DEFAULT 0,
    discount_amount numeric(10,2) NOT NULL DEFAULT 0,
    subtotal numeric(10,2) NOT NULL,
    notes text,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT pos_session_items_qty_pos CHECK ((qty > (0)::numeric)),
    CONSTRAINT pos_session_items_amounts_nonneg CHECK ((unit_price >= 0 AND cost_price >= 0 AND tax_rate >= 0 AND discount_amount >= 0 AND subtotal >= 0))
);

COMMENT ON TABLE public.pos_session_items IS
    'S263: line items on an open POS session. Shape mirrors pos_transaction_items so checkout can copy them across cleanly. item_id can be NULL for ad-hoc / non-catalog items.';

ALTER TABLE public.pos_session_items
    ADD CONSTRAINT pos_session_items_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.pos_sessions(id) ON DELETE CASCADE,
    ADD CONSTRAINT pos_session_items_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.pos_items(id),
    ADD CONSTRAINT pos_session_items_item_variant_id_fkey FOREIGN KEY (item_variant_id) REFERENCES public.pos_item_variants(id);

CREATE INDEX pos_session_items_session_idx
    ON public.pos_session_items (session_id, created_at);
