-- Move-out deposit-return disposition record.
--
-- One row per lease at move-out time. Captures:
--   - the deposit snapshot (so re-running the calc later doesn't drift
--     if the security_deposits row changes)
--   - automated deductions (cleaning_fee pulled from lease_fees with
--     due_timing='move_out')
--   - landlord-added damage lines (free-form description + amount)
--   - other_deductions catch-all (utilities, last-month-rent, etc.)
--   - the resulting refund (positive = tenant gets money back) or gap
--     (positive = tenant owes more than deposit covers)
--
-- Lifecycle:
--   draft         — landlord is reviewing/adjusting
--   sent_refund   — finalized; refund payment created and credited to tenant
--   sent_gap      — finalized; gap invoice created + auto-charge attempted
--   sent_zero     — finalized; deductions exactly equaled deposit (no money moved)
--   disputed      — tenant disputed via the standard credit-dispute flow
--
-- gap_payment_id links to the payments row created when a gap was
-- charged. NULL when there's no gap or charge failed (landlord
-- resolves manually).
--
-- No backfill needed.

CREATE TABLE deposit_returns (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id                 UUID NOT NULL REFERENCES leases(id),
  tenant_id                UUID NOT NULL REFERENCES tenants(id),
  landlord_id              UUID NOT NULL REFERENCES landlords(id),
  security_deposit_id      UUID REFERENCES security_deposits(id),

  total_deposit            NUMERIC(10,2) NOT NULL,
  cleaning_fee_amount      NUMERIC(10,2) NOT NULL DEFAULT 0,
  damage_lines             JSONB NOT NULL DEFAULT '[]'::jsonb,
  other_deductions         JSONB NOT NULL DEFAULT '[]'::jsonb,
  total_deductions         NUMERIC(10,2) NOT NULL,

  refund_amount            NUMERIC(10,2) NOT NULL DEFAULT 0,
  gap_amount               NUMERIC(10,2) NOT NULL DEFAULT 0,

  status                   TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft', 'sent_refund', 'sent_gap', 'sent_zero', 'disputed'
  )),
  refund_payment_id        UUID REFERENCES payments(id),
  gap_payment_id           UUID REFERENCES payments(id),
  gap_charge_failed        BOOLEAN NOT NULL DEFAULT FALSE,
  gap_charge_failure_reason TEXT,

  finalized_at             TIMESTAMPTZ,
  finalized_by_user_id     UUID REFERENCES users(id),
  notes                    TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Only one active deposit-return per lease (re-do via a new row only
  -- after the prior one is disputed and resolved).
  UNIQUE (lease_id)
);

CREATE INDEX idx_deposit_returns_tenant   ON deposit_returns (tenant_id);
CREATE INDEX idx_deposit_returns_landlord ON deposit_returns (landlord_id);
CREATE INDEX idx_deposit_returns_status   ON deposit_returns (status);
