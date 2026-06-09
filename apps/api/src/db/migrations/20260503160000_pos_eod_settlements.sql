-- S95 / DEFERRED Item 14 EOD reconciliation: pos_eod_settlements.
--
-- Daily roll-up per (landlord, business_day) closing the cashier's day.
-- A daily cron (scheduler.ts) auto-generates yesterday's settlement at
-- 3am Phoenix; cashiers can manually close the day earlier with a
-- cash-drawer count via POST /api/pos/eod/close. Re-running for the
-- same day is safe (UNIQUE on landlord_id + business_day; the engine
-- uses INSERT ... ON CONFLICT UPDATE to refresh totals).
--
-- "business_day" is America/Phoenix calendar date — the platform's
-- canonical tz per CLAUDE.md. RV parks are open 24/7 but books close
-- by Phoenix calendar day for owner reporting.
--
-- Cash drawer math:
--   expected = opening_float + cash_sales - cash_refunds
--   actual   = cashier-entered count at close (NULL if auto_closed)
--   variance = actual - expected (NULL when actual is NULL)
--   variance is a STORED generated column so the math stays in one
--   place regardless of who/what closes the day.
--
-- Status flow:
--   auto_closed     — cron generated; cashier hasn't manually counted
--   manually_closed — cashier ran POST /eod/close with drawer actual
--   reopened        — admin override (lets stale txns/refunds for
--                     yesterday roll into a regenerated settlement)

CREATE TABLE pos_eod_settlements (
    id                    uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    landlord_id           uuid NOT NULL REFERENCES landlords(id) ON DELETE RESTRICT,
    business_day          date NOT NULL,

    -- Totals (snapshot at close time)
    cash_sales            numeric(12,2) NOT NULL DEFAULT 0,
    card_sales            numeric(12,2) NOT NULL DEFAULT 0,
    charge_sales          numeric(12,2) NOT NULL DEFAULT 0,
    cash_refunds          numeric(12,2) NOT NULL DEFAULT 0,
    card_refunds          numeric(12,2) NOT NULL DEFAULT 0,
    charge_refunds        numeric(12,2) NOT NULL DEFAULT 0,

    tax_collected         numeric(12,2) NOT NULL DEFAULT 0,
    surcharge_collected   numeric(12,2) NOT NULL DEFAULT 0,
    platform_fee_total    numeric(12,2) NOT NULL DEFAULT 0,

    tx_count              integer NOT NULL DEFAULT 0,
    refund_count          integer NOT NULL DEFAULT 0,
    voided_count          integer NOT NULL DEFAULT 0,

    -- Cash drawer
    opening_float         numeric(10,2) NOT NULL DEFAULT 0,
    cash_drawer_actual    numeric(10,2),
    cash_drawer_expected  numeric(10,2) GENERATED ALWAYS AS
                            (opening_float + cash_sales - cash_refunds) STORED,
    cash_drawer_variance  numeric(10,2) GENERATED ALWAYS AS
                            (cash_drawer_actual - (opening_float + cash_sales - cash_refunds)) STORED,

    status                text NOT NULL DEFAULT 'auto_closed',
    closed_at             timestamp with time zone NOT NULL DEFAULT now(),
    closed_by             uuid REFERENCES users(id) ON DELETE SET NULL,

    notes                 text,
    created_at            timestamp with time zone NOT NULL DEFAULT now(),
    updated_at            timestamp with time zone NOT NULL DEFAULT now(),

    CONSTRAINT pos_eod_settlements_status_check
      CHECK (status = ANY (ARRAY['auto_closed','manually_closed','reopened'])),
    CONSTRAINT pos_eod_settlements_one_per_day
      UNIQUE (landlord_id, business_day)
);

CREATE INDEX idx_pos_eod_landlord_day
  ON pos_eod_settlements(landlord_id, business_day DESC);
