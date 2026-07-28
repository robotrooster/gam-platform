-- S561 (money-flow platform-holds rebuild, Phase 3): post-settlement payment
-- reversals + landlord receivable.
--
-- WHY: under platform-holds (memory gam-money-flow-platform-holds), rent settles
-- on GAM's platform balance and is batched to the landlord (Tuesday). If that
-- payment later reverses AFTER it has been paid out — a late ACH unauthorized
-- return / ACH return (up to 60 days) or a card chargeback — GAM is the merchant
-- of record and Stripe pulls the funds back from the platform balance, but the
-- money is already sitting in the landlord's bank. This table is the receivable
-- + state machine that drives (a) reopening the tenant's obligation and (b)
-- reclaiming the rent from the already-paid landlord (net-vs-ACH-pull per the
-- 7-day guaranteed-lease influx rule). The tenant-side reopened charges
-- (re-owed rent, recomputed late fee, reversal fee) live as normal `payments`
-- rows; card-dispute audit continues to live in `connect_disputes`. This table
-- does not duplicate either — it tracks the reversal event, the landlord
-- receivable, and the outcome.
--
-- Enum values mirror packages/shared/src/index.ts PAYMENT_REVERSAL_* (single
-- source of truth). No backfill needed — new table, forward-only.

CREATE TABLE public.payment_reversals (
    id                 uuid DEFAULT public.uuid_generate_v4() NOT NULL,

    -- What reversed
    payment_id         uuid NOT NULL,          -- the original settled payment that reversed
    landlord_id        uuid,                    -- the (already-paid) landlord to reclaim from
    tenant_id          uuid,                    -- the tenant whose payment reversed
    lease_id           uuid,                    -- context
    reversal_type      text NOT NULL,           -- ach_return | ach_unauthorized | card_dispute
    reversed_amount    numeric(10,2) NOT NULL,  -- rent principal reversed (what Stripe pulled back)
    reversal_fee       numeric(10,2) NOT NULL DEFAULT 0,  -- $4 ACH / $15 card GAM was charged; billed to tenant

    -- Idempotency + audit
    stripe_event_id    text NOT NULL,           -- the webhook event that opened this (unique guard)
    stripe_object_id   text,                    -- dispute id / charge id / refund id
    connect_dispute_id uuid,                    -- link to connect_disputes audit row (card only; null for ACH)
    raw_event          jsonb NOT NULL,          -- raw webhook payload, append-only

    -- Landlord recovery (clawback / netting)
    recovery_method    text,                    -- null until decided | netting | ach_pull
    recovery_status    text NOT NULL DEFAULT 'pending',  -- pending | scheduled_netting | recovered | not_needed
    recovered_amount   numeric(10,2) NOT NULL DEFAULT 0,
    recovered_at       timestamp with time zone,

    -- Outcome (who ultimately eats it / owns the late fee)
    outcome            text,                    -- null until resolved | tenant_paid | landlord_clawback | written_off
    late_fee_owner     text,                    -- null until resolved | gam | landlord
    resolved_at        timestamp with time zone,

    status             text NOT NULL DEFAULT 'open',  -- open | recovering | resolved
    created_at         timestamp with time zone DEFAULT now() NOT NULL,
    updated_at         timestamp with time zone DEFAULT now() NOT NULL,

    CONSTRAINT payment_reversals_pkey PRIMARY KEY (id),
    CONSTRAINT payment_reversals_payment_id_fkey
        FOREIGN KEY (payment_id) REFERENCES public.payments(id),
    CONSTRAINT payment_reversals_connect_dispute_id_fkey
        FOREIGN KEY (connect_dispute_id) REFERENCES public.connect_disputes(id),
    CONSTRAINT payment_reversals_stripe_event_id_key UNIQUE (stripe_event_id),
    CONSTRAINT payment_reversals_type_check
        CHECK (reversal_type = ANY (ARRAY['ach_return'::text, 'ach_unauthorized'::text, 'card_dispute'::text])),
    CONSTRAINT payment_reversals_recovery_method_check
        CHECK (recovery_method IS NULL OR recovery_method = ANY (ARRAY['netting'::text, 'ach_pull'::text])),
    CONSTRAINT payment_reversals_recovery_status_check
        CHECK (recovery_status = ANY (ARRAY['pending'::text, 'scheduled_netting'::text, 'recovered'::text, 'not_needed'::text])),
    CONSTRAINT payment_reversals_outcome_check
        CHECK (outcome IS NULL OR outcome = ANY (ARRAY['tenant_paid'::text, 'landlord_clawback'::text, 'written_off'::text])),
    CONSTRAINT payment_reversals_late_fee_owner_check
        CHECK (late_fee_owner IS NULL OR late_fee_owner = ANY (ARRAY['gam'::text, 'landlord'::text])),
    CONSTRAINT payment_reversals_status_check
        CHECK (status = ANY (ARRAY['open'::text, 'recovering'::text, 'resolved'::text]))
);

-- Recovery cron scans open receivables needing a clawback decision / execution.
CREATE INDEX idx_payment_reversals_recovery
    ON public.payment_reversals (recovery_status)
    WHERE status <> 'resolved';

-- Per-landlord lookup (netting against a landlord's upcoming batch).
CREATE INDEX idx_payment_reversals_landlord
    ON public.payment_reversals (landlord_id)
    WHERE status <> 'resolved';

-- Per-payment / per-tenant lookups.
CREATE INDEX idx_payment_reversals_payment ON public.payment_reversals (payment_id);
CREATE INDEX idx_payment_reversals_tenant  ON public.payment_reversals (tenant_id);
