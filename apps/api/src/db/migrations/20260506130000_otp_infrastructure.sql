-- OTP (On-Time Pay) infrastructure (S155).
--
-- Product model: rent advance for landlords. GAM advances rent on
-- the last business day of the month so funds clear in landlord's
-- bank by the 1st. GAM collects from tenant via normal ACH at the
-- tenant's regular pull date later in the month. Revenue = 1%
-- spread on advanced amount.
--
-- Risk model: first NSF, GAM eats the loss. Tenant disqualified for
-- 6 months. No collection pursuit (regulatory boundary).
--
-- Hidden until rollout: gated by system_features.otp_rollout_visible
-- (default FALSE) + per-landlord landlords.otp_rollout_enabled
-- (default FALSE). Both must be TRUE for OTP to surface to a
-- landlord.
--
-- ─── system_features ─────────────────────────────────────────
-- Platform-level feature flags. Super_admin-only. Schema designed
-- generically so future flags reuse the same table without per-
-- feature migrations.
--
-- ─── landlords.otp_rollout_enabled ───────────────────────────
-- Per-landlord beta gate. Allows phased rollout: super_admin
-- enables the platform flag, then flips this column per-landlord
-- as they're invited to the beta cohort.
--
-- ─── tenants.otp_disqualified_until + reason ─────────────────
-- After an NSF, tenant is disqualified from OTP for 6 months. The
-- timestamp + reason captures the cooldown. Qualification check
-- compares NOW() to this column. NULL means never disqualified.
--
-- ─── otp_advances ────────────────────────────────────────────
-- One row per (cycle_month, tenant_id). Created when the cron
-- advances rent. Status lifecycle:
--   pending          — advance created but not yet sent
--   advanced         — funds initiated to landlord
--   reconciled       — tenant rent settled; advance closed out, fee captured
--   defaulted        — tenant NSF'd; GAM eats the loss
--
-- No backfill needed.

CREATE TABLE system_features (
  key             TEXT PRIMARY KEY,
  enabled         BOOLEAN NOT NULL DEFAULT FALSE,
  description     TEXT NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by_user_id UUID REFERENCES users(id)
);

INSERT INTO system_features (key, enabled, description) VALUES
  ('otp_rollout_visible', FALSE,
   'OTP (On-Time Pay) rent-advance product. When TRUE, eligible landlords with otp_rollout_enabled=TRUE see the OTP UI surfaces. When FALSE, OTP is invisible to all landlords regardless of per-landlord flag.');

ALTER TABLE landlords
  ADD COLUMN otp_rollout_enabled BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE tenants
  ADD COLUMN otp_disqualified_until TIMESTAMPTZ,
  ADD COLUMN otp_disqualified_reason TEXT;

CREATE TABLE otp_advances (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_month                 DATE NOT NULL,         -- e.g. '2026-05-01'
  tenant_id                   UUID NOT NULL REFERENCES tenants(id),
  landlord_id                 UUID NOT NULL REFERENCES landlords(id),
  unit_id                     UUID NOT NULL REFERENCES units(id),
  lease_id                    UUID NOT NULL REFERENCES leases(id),

  rent_amount                 NUMERIC(10,2) NOT NULL,
  fee_amount                  NUMERIC(10,2) NOT NULL,   -- 1% of rent_amount
  advance_amount              NUMERIC(10,2) NOT NULL,   -- rent_amount - fee_amount

  status                      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'advanced', 'reconciled', 'defaulted'
  )),
  advance_payment_id          UUID REFERENCES payments(id),  -- payout to landlord
  reconciled_with_payment_id  UUID REFERENCES payments(id),  -- tenant rent payment that closed it out
  advanced_at                 TIMESTAMPTZ,
  reconciled_at               TIMESTAMPTZ,
  defaulted_at                TIMESTAMPTZ,
  default_reason              TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- One advance per (cycle, tenant). Re-run safe.
  UNIQUE (cycle_month, tenant_id)
);

CREATE INDEX idx_otp_advances_landlord ON otp_advances (landlord_id, cycle_month DESC);
CREATE INDEX idx_otp_advances_tenant   ON otp_advances (tenant_id, cycle_month DESC);
CREATE INDEX idx_otp_advances_status   ON otp_advances (status);
