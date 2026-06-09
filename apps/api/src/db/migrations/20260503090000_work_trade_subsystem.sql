-- S88 / DEFERRED Item 6: work-trade subsystem.
--
-- Three tables backing the work-trade routes (apps/api/src/routes/workTrade.ts):
-- agreements anchor a tenant + unit + landlord with rate/hours/credit terms;
-- logs are tenant-submitted hours for a given work date awaiting landlord
-- approval; periods track per-month commitment vs. actual + reconcile
-- shortfall into cash_due so the rent flow knows what to charge.
--
-- Confirmed at S57 as build-not-rip — RV park operators in particular use
-- work-trade to cover front-desk shifts, grounds, light maintenance in
-- exchange for rent credit. The 1099 threshold logic ($600/year flag) lives
-- in workTrade.ts:222-227 and consumes work_trade_agreements.ytd_value +
-- flag_1099 + tax_year here.
--
-- Idempotency keys:
--   - work_trade_periods has UNIQUE(agreement_id, period_month, period_year)
--     so the route's `INSERT ... ON CONFLICT DO NOTHING` (line 70-76,
--     269-275) actually has something to conflict against.

CREATE TABLE work_trade_agreements (
    id                uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    unit_id           uuid NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
    tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    landlord_id       uuid NOT NULL REFERENCES landlords(id) ON DELETE RESTRICT,

    trade_type        text NOT NULL,
    hourly_rate       numeric(10,2) NOT NULL,
    weekly_hours      numeric(6,2) NOT NULL,
    market_rent       numeric(10,2) NOT NULL,
    cash_rent         numeric(10,2) NOT NULL DEFAULT 0,
    trade_credit_max  numeric(10,2) NOT NULL,

    duties            text,
    start_date        date NOT NULL,
    end_date          date,
    renewal_terms     text,

    status            text NOT NULL DEFAULT 'active',
    ytd_value         numeric(10,2) NOT NULL DEFAULT 0,
    flag_1099         boolean NOT NULL DEFAULT FALSE,
    tax_year          integer NOT NULL DEFAULT EXTRACT(YEAR FROM CURRENT_DATE)::integer,

    created_at        timestamp with time zone NOT NULL DEFAULT now(),
    updated_at        timestamp with time zone NOT NULL DEFAULT now(),

    CONSTRAINT work_trade_agreements_trade_type_check
      CHECK (trade_type = ANY (ARRAY['full','partial','credit'])),
    CONSTRAINT work_trade_agreements_status_check
      CHECK (status = ANY (ARRAY['active','paused','ended']))
);

CREATE INDEX idx_work_trade_agreements_landlord ON work_trade_agreements(landlord_id, created_at DESC);
CREATE INDEX idx_work_trade_agreements_tenant   ON work_trade_agreements(tenant_id);
CREATE INDEX idx_work_trade_agreements_unit     ON work_trade_agreements(unit_id);

CREATE TABLE work_trade_logs (
    id               uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    agreement_id     uuid NOT NULL REFERENCES work_trade_agreements(id) ON DELETE CASCADE,
    tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    submitted_by     uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

    work_date        date NOT NULL,
    hours            numeric(6,2) NOT NULL,
    description      text NOT NULL,

    status           text NOT NULL DEFAULT 'pending',
    reviewed_by      uuid REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at      timestamp with time zone,
    rejection_reason text,
    credit_value     numeric(10,2),

    created_at       timestamp with time zone NOT NULL DEFAULT now(),

    CONSTRAINT work_trade_logs_status_check
      CHECK (status = ANY (ARRAY['pending','approved','rejected']))
);

CREATE INDEX idx_work_trade_logs_agreement ON work_trade_logs(agreement_id, work_date DESC);
CREATE INDEX idx_work_trade_logs_status    ON work_trade_logs(status) WHERE status = 'pending';

CREATE TABLE work_trade_periods (
    id                uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    agreement_id      uuid NOT NULL REFERENCES work_trade_agreements(id) ON DELETE CASCADE,

    period_month      integer NOT NULL,
    period_year       integer NOT NULL,

    hours_committed   numeric(6,2) NOT NULL,
    hours_worked      numeric(6,2) NOT NULL DEFAULT 0,
    hours_short       numeric(6,2) NOT NULL DEFAULT 0,
    credit_earned     numeric(10,2) NOT NULL DEFAULT 0,
    shortfall_charge  numeric(10,2) NOT NULL DEFAULT 0,
    cash_due          numeric(10,2) NOT NULL,

    status            text NOT NULL DEFAULT 'open',
    reconciled_at     timestamp with time zone,

    created_at        timestamp with time zone NOT NULL DEFAULT now(),

    CONSTRAINT work_trade_periods_status_check
      CHECK (status = ANY (ARRAY['open','reconciled'])),
    CONSTRAINT work_trade_periods_month_check
      CHECK (period_month BETWEEN 1 AND 12),
    CONSTRAINT work_trade_periods_unique_per_agreement_month
      UNIQUE (agreement_id, period_month, period_year)
);

CREATE INDEX idx_work_trade_periods_agreement ON work_trade_periods(agreement_id, period_year DESC, period_month DESC);
