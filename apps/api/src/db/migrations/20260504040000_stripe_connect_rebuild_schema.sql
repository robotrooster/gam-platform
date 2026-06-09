-- S114: schema migration for the Stripe Connect Express rebuild.
--
-- This migration adds the schema scaffolding the rest of the Connect
-- rebuild (S115+) will build on top of. NO route or service changes
-- here — those land in S115/S116/etc. once the schema is verified.
--
-- Scope:
--   1. users.stripe_connect_account_id — per-user Connect account
--   2. pm_companies.stripe_connect_account_id — per-pm-company Connect
--   3. property_allocation_rules — split fee-payer toggles into three
--      independent fields (ACH / card / platform) per S113 product
--      decision. Keep banking_fee_payer for now (deprecated mirror);
--      S116 allocation engine refactor will retire it.
--   4. platform_fee_config — effective-dated config for $2/unit +
--      $10/property minimum platform fee (superadmin-editable)
--   5. landlord_platform_fee_overrides — effective-dated per-landlord
--      rate cuts for high-volume customers
--   6. platform_fee_accruals — monthly audit trail per
--      (landlord, property, month) with snapshot fields
--
-- Architecture references:
--   - project_stripe_connect_rail.md memory
--   - project_gam_pricing_model.md memory
--   - CLAUDE.md "Stripe Connect Express + destination charges" section

-- ── 1. users.stripe_connect_account_id ──────────────────────────────────

ALTER TABLE users
  ADD COLUMN stripe_connect_account_id text;

CREATE UNIQUE INDEX idx_users_stripe_connect_account_id
  ON users(stripe_connect_account_id)
  WHERE stripe_connect_account_id IS NOT NULL;

-- ── 2. pm_companies.stripe_connect_account_id ──────────────────────────

ALTER TABLE pm_companies
  ADD COLUMN stripe_connect_account_id text;

CREATE UNIQUE INDEX idx_pm_companies_stripe_connect_account_id
  ON pm_companies(stripe_connect_account_id)
  WHERE stripe_connect_account_id IS NOT NULL;

-- ── 3. property_allocation_rules — three-way fee payer split ───────────
--
-- Pre-S113 the table had a single banking_fee_payer ('landlord'|'tenant')
-- that controlled both ACH and card processing fees together. S113
-- product decision: every fee GAM charges has its own per-property
-- pass-through toggle. Split into:
--   ach_fee_payer       — controls 1.0% capped $6 ACH processing fee
--   card_fee_payer      — controls 3.25% card processing fee
--   platform_fee_payer  — controls $2/unit + $10/min platform SaaS fee
--
-- Default for ACH and card seeds from the existing banking_fee_payer
-- value to preserve current behavior. Default for platform_fee_payer
-- is 'landlord' (current implicit behavior — landlord absorbs).
--
-- banking_fee_payer column kept as deprecated mirror for one session
-- so the live allocation engine doesn't break. S116 allocation refactor
-- retires it.

ALTER TABLE property_allocation_rules
  ADD COLUMN ach_fee_payer       text,
  ADD COLUMN card_fee_payer      text,
  ADD COLUMN platform_fee_payer  text NOT NULL DEFAULT 'landlord';

UPDATE property_allocation_rules
   SET ach_fee_payer  = banking_fee_payer,
       card_fee_payer = banking_fee_payer
 WHERE ach_fee_payer IS NULL OR card_fee_payer IS NULL;

ALTER TABLE property_allocation_rules
  ALTER COLUMN ach_fee_payer  SET NOT NULL,
  ALTER COLUMN card_fee_payer SET NOT NULL;

ALTER TABLE property_allocation_rules
  ADD CONSTRAINT property_allocation_rules_ach_fee_payer_check
    CHECK (ach_fee_payer = ANY (ARRAY['landlord', 'tenant'])),
  ADD CONSTRAINT property_allocation_rules_card_fee_payer_check
    CHECK (card_fee_payer = ANY (ARRAY['landlord', 'tenant'])),
  ADD CONSTRAINT property_allocation_rules_platform_fee_payer_check
    CHECK (platform_fee_payer = ANY (ARRAY['landlord', 'tenant']));

COMMENT ON COLUMN property_allocation_rules.banking_fee_payer IS
  'DEPRECATED S113 — superseded by ach_fee_payer + card_fee_payer + platform_fee_payer. Kept as mirror for the legacy allocation engine until S116 refactor.';

-- ── 4. platform_fee_config ─────────────────────────────────────────────
--
-- Singleton-ish: the "active" config is the row with effective_until
-- IS NULL. When superadmin changes rates, the old row gets end-dated
-- and a new row is inserted. Preserves rate history for audit.

CREATE TABLE platform_fee_config (
    id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    rate_per_unit       numeric(10,2) NOT NULL DEFAULT 2.00,
    min_per_property    numeric(10,2) NOT NULL DEFAULT 10.00,
    effective_from      date NOT NULL DEFAULT CURRENT_DATE,
    effective_until     date,
    set_by_user_id      uuid REFERENCES users(id) ON DELETE SET NULL,
    notes               text,
    created_at          timestamp with time zone NOT NULL DEFAULT now(),

    CONSTRAINT platform_fee_config_rate_nonneg
      CHECK (rate_per_unit >= 0),
    CONSTRAINT platform_fee_config_min_nonneg
      CHECK (min_per_property >= 0),
    CONSTRAINT platform_fee_config_effective_range
      CHECK (effective_until IS NULL OR effective_until > effective_from)
);

-- Only one row may have effective_until IS NULL at any time —
-- the "active" config. Partial UNIQUE enforces.
CREATE UNIQUE INDEX platform_fee_config_one_active
  ON platform_fee_config((effective_until IS NULL))
  WHERE effective_until IS NULL;

-- Seed initial $2/$10 default
INSERT INTO platform_fee_config (rate_per_unit, min_per_property, notes)
VALUES (2.00, 10.00, 'S113 launch defaults');

-- ── 5. landlord_platform_fee_overrides ─────────────────────────────────
--
-- Per-landlord override of either rate_per_unit, min_per_property, or
-- both. NULL on a field = inherit from platform_fee_config.

CREATE TABLE landlord_platform_fee_overrides (
    id                uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    landlord_id       uuid NOT NULL REFERENCES landlords(id) ON DELETE CASCADE,
    rate_per_unit     numeric(10,2),
    min_per_property  numeric(10,2),
    effective_from    date NOT NULL DEFAULT CURRENT_DATE,
    effective_until   date,
    set_by_user_id    uuid REFERENCES users(id) ON DELETE SET NULL,
    reason            text,
    created_at        timestamp with time zone NOT NULL DEFAULT now(),

    CONSTRAINT landlord_pfo_rate_nonneg
      CHECK (rate_per_unit IS NULL OR rate_per_unit >= 0),
    CONSTRAINT landlord_pfo_min_nonneg
      CHECK (min_per_property IS NULL OR min_per_property >= 0),
    CONSTRAINT landlord_pfo_effective_range
      CHECK (effective_until IS NULL OR effective_until > effective_from),
    CONSTRAINT landlord_pfo_at_least_one
      CHECK (rate_per_unit IS NOT NULL OR min_per_property IS NOT NULL)
);

-- One active override per landlord at a time. Partial UNIQUE.
CREATE UNIQUE INDEX landlord_pfo_one_active_per_landlord
  ON landlord_platform_fee_overrides(landlord_id)
  WHERE effective_until IS NULL;

CREATE INDEX idx_landlord_pfo_landlord ON landlord_platform_fee_overrides(landlord_id, created_at DESC);

-- ── 6. platform_fee_accruals ───────────────────────────────────────────
--
-- Monthly audit trail. One row per (landlord, property, month). Snapshot
-- fields preserve the math at accrual time so future rate edits don't
-- retroactively change historical billing. Mirrors the
-- pm_monthly_fee_accruals (S111) shape.

CREATE TABLE platform_fee_accruals (
    id                       uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    landlord_id              uuid NOT NULL REFERENCES landlords(id) ON DELETE RESTRICT,
    property_id              uuid NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
    accrual_month            date NOT NULL,

    -- Per-property unit math snapshot (per S113 RV/STR aggregation rule)
    long_term_unit_count     integer NOT NULL DEFAULT 0,
    short_stay_nights        integer NOT NULL DEFAULT 0,
    short_stay_equivalent    integer NOT NULL DEFAULT 0,
    total_billable           integer NOT NULL DEFAULT 0,

    -- Rate snapshot
    rate_per_unit            numeric(10,2) NOT NULL,
    min_per_property         numeric(10,2) NOT NULL,
    total_amount             numeric(10,2) NOT NULL,

    -- Who pays (snapshot of platform_fee_payer at accrual time)
    payer                    text NOT NULL,

    -- Traceability
    platform_revenue_ledger_id uuid REFERENCES platform_revenue_ledger(id) ON DELETE SET NULL,
    tenant_charge_id           uuid,  -- optional: when payer='tenant', the rent payment that absorbed it

    created_at               timestamp with time zone NOT NULL DEFAULT now(),
    updated_at               timestamp with time zone NOT NULL DEFAULT now(),

    CONSTRAINT platform_fee_accruals_payer_check
      CHECK (payer = ANY (ARRAY['landlord', 'tenant'])),
    CONSTRAINT platform_fee_accruals_unique
      UNIQUE (landlord_id, property_id, accrual_month)
);

CREATE INDEX idx_pfa_landlord_month
  ON platform_fee_accruals(landlord_id, accrual_month DESC);
CREATE INDEX idx_pfa_property_month
  ON platform_fee_accruals(property_id, accrual_month DESC);
