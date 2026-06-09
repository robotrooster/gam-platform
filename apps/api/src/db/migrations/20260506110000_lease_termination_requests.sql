-- Early-termination request audit trail.
--
-- One row per tenant-initiated early termination. Captures:
--   - requested_at + requested_by + reason
--   - fee_amount that was quoted at request time (frozen — landlord
--     can't change the policy mid-flight)
--   - fee_basis: 'lease_specific' (lease_fees row with type
--     'early_termination_fee'), 'landlord_default'
--     (landlords.default_early_termination_months_rent × rent), or
--     'no_policy' (no fee — terminated free)
--   - fee_payment_id when the auto-charge runs
--   - fee_paid_at OR fee_waived_at — only one populated per request
--   - terminated_at — when the lease actually flipped to terminated
--   - status lifecycle:
--       requested      — tenant initiated, awaiting charge
--       fee_paid       — charge succeeded; lease terminated
--       fee_waived     — landlord waived; lease terminated
--       terminated     — historical state for legacy paths
--       cancelled      — tenant backed out before lease flipped
--       failed         — auto-charge failed; tenant can retry or cancel
--
-- Per the locked design (S153 Q4: A), once status is fee_paid or
-- fee_waived, the lease.status flips to 'terminated' immediately.
-- Move-out logistics (deposit return, etc.) run as separate
-- workflows post-termination.
--
-- One active request per lease enforced via a partial unique
-- index excluding terminal statuses.
--
-- Also adds landlords.default_early_termination_months_rent
-- (numeric, nullable) for the per-landlord default policy. NULL =
-- no policy on file; tenants see "contact landlord" if their lease
-- has no early_termination_fee row either.
--
-- No backfill needed.

ALTER TABLE landlords
  ADD COLUMN default_early_termination_months_rent NUMERIC(5,2);

CREATE TABLE lease_termination_requests (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id                 UUID NOT NULL REFERENCES leases(id),
  tenant_id                UUID NOT NULL REFERENCES tenants(id),
  landlord_id              UUID NOT NULL REFERENCES landlords(id),

  requested_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  requested_by_user_id     UUID NOT NULL REFERENCES users(id),
  reason                   TEXT,

  fee_amount               NUMERIC(10,2) NOT NULL,
  fee_basis                TEXT NOT NULL CHECK (fee_basis IN (
    'lease_specific', 'landlord_default', 'no_policy'
  )),

  fee_payment_id           UUID REFERENCES payments(id),
  fee_paid_at              TIMESTAMPTZ,
  fee_charge_failed        BOOLEAN NOT NULL DEFAULT FALSE,
  fee_charge_failure_reason TEXT,

  fee_waived_at            TIMESTAMPTZ,
  fee_waived_by_user_id    UUID REFERENCES users(id),
  fee_waiver_reason        TEXT,

  terminated_at            TIMESTAMPTZ,
  status                   TEXT NOT NULL DEFAULT 'requested' CHECK (status IN (
    'requested', 'fee_paid', 'fee_waived', 'terminated', 'cancelled', 'failed'
  )),
  notes                    TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_lease_termination_requests_lease    ON lease_termination_requests (lease_id);
CREATE INDEX idx_lease_termination_requests_tenant   ON lease_termination_requests (tenant_id);
CREATE INDEX idx_lease_termination_requests_status   ON lease_termination_requests (status);

-- Only one active termination request per lease at a time. Once
-- it lands in a terminal status (fee_paid / fee_waived / terminated /
-- cancelled / failed) a new request can be opened.
CREATE UNIQUE INDEX idx_lease_termination_requests_one_active
  ON lease_termination_requests (lease_id)
  WHERE status = 'requested';
