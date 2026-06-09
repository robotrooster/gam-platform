-- S246: FlexDeposit installment plan + custody fee tracking.
--
-- FlexDeposit is a tenant-paid deposit-installment product. Tenant
-- elects 2-4 installments (based on deposit amount × BG risk_level);
-- installment 1 paid at move-in, remaining N-1 spread over the next
-- N-1 months. GAM fronts the gap to landlord at move-in so the
-- landlord sees deposit funded in full from day 1; tenant pays GAM
-- back over the installment schedule. $3/month custody fee billed
-- continuously while tenant is on the GAM platform (not just during
-- installment-payoff — covers ongoing escrow custody costs).
--
-- Risk model: GAM eats the loss if tenant defaults. Same posture as
-- OTP / FlexPay. Tier formula favors larger deposits with fewer
-- installments to minimize GAM's outstanding exposure (Nic confirmed
-- S246 — "we can't go after non-payment for damages").
--
-- Visibility: landlord NEVER sees FlexDeposit. Deposit appears as
-- normally-funded on the landlord's deposits page; installments +
-- custody fee are tenant↔GAM ledger entries only.
--
-- ── Schema additions ─────────────────────────────────────────────
-- 1. flex_deposit_installments — one row per installment in the plan.
--    Installment 1 is created at move-in with status='settled' (the
--    tenant pays it as part of the move-in PI). Installments 2..N
--    created with status='pending' and due_date stamped at +1 month
--    intervals from move-in. Cron walks 'pending' rows due today,
--    fires ACH pull, flips to 'settled' on webhook success.
-- 2. flex_deposit_custody_charges — $3/mo recurring charge log. Cron
--    walks active enrollments monthly, inserts a charge row + fires
--    ACH pull.
-- 3. security_deposits.flex_deposit_plan_status — top-level plan
--    state (active / completed / in_default). Lets queries answer
--    "is this tenant's deposit on an active installment plan" without
--    JOINing the installments table.
-- 4. security_deposits.gam_advance_amount — dollar amount GAM
--    fronted to landlord at move-in (= installment_amount × (N-1)).
--    Tracks GAM's outstanding receivable from the tenant.
-- 5. tenants.flex_deposit_disqualified_until / reason — 60-day
--    cooldown after default. Mirrors OTP / FlexPay disqualification.

ALTER TABLE security_deposits
  ADD COLUMN flex_deposit_plan_status text,
  ADD COLUMN gam_advance_amount numeric(10,2) DEFAULT 0;

ALTER TABLE security_deposits
  ADD CONSTRAINT security_deposits_plan_status_check
    CHECK (flex_deposit_plan_status IS NULL OR
           flex_deposit_plan_status = ANY (ARRAY['active', 'completed', 'in_default']));

ALTER TABLE tenants
  ADD COLUMN flex_deposit_disqualified_until  timestamptz,
  ADD COLUMN flex_deposit_disqualified_reason text;

CREATE TABLE flex_deposit_installments (
  id                   uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  security_deposit_id  uuid NOT NULL REFERENCES security_deposits(id),
  tenant_id            uuid NOT NULL REFERENCES tenants(id),
  installment_number   integer NOT NULL,    -- 1..N
  installment_count    integer NOT NULL,    -- N (denormalized for query convenience)
  amount               numeric(10,2) NOT NULL,
  due_date             date NOT NULL,
  status               text NOT NULL DEFAULT 'pending',
  payment_id           uuid REFERENCES payments(id),
  attempted_at         timestamptz,
  settled_at           timestamptz,
  defaulted_at         timestamptz,
  default_reason       text,
  created_at           timestamptz NOT NULL DEFAULT NOW(),
  updated_at           timestamptz NOT NULL DEFAULT NOW(),

  CONSTRAINT flex_deposit_installments_status_check
    CHECK (status = ANY (ARRAY['pending', 'settled', 'failed', 'defaulted'])),
  CONSTRAINT flex_deposit_installments_number_check
    CHECK (installment_number >= 1 AND installment_number <= installment_count),
  CONSTRAINT flex_deposit_installments_count_check
    CHECK (installment_count BETWEEN 2 AND 4),
  CONSTRAINT flex_deposit_installments_amount_positive
    CHECK (amount > 0),
  CONSTRAINT flex_deposit_installments_uniq
    UNIQUE (security_deposit_id, installment_number)
);

CREATE INDEX idx_flex_deposit_installments_tenant
  ON flex_deposit_installments (tenant_id, due_date);
CREATE INDEX idx_flex_deposit_installments_due
  ON flex_deposit_installments (due_date) WHERE status = 'pending';
CREATE INDEX idx_flex_deposit_installments_deposit
  ON flex_deposit_installments (security_deposit_id);

-- Custody fee charges — $3/month while tenant has any active
-- FlexDeposit-enrolled deposit on the GAM platform.

CREATE TABLE flex_deposit_custody_charges (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  cycle_month   date NOT NULL,
  amount        numeric(10,2) NOT NULL,
  payment_id    uuid REFERENCES payments(id),
  status        text NOT NULL DEFAULT 'pending',
  created_at    timestamptz NOT NULL DEFAULT NOW(),
  updated_at    timestamptz NOT NULL DEFAULT NOW(),

  CONSTRAINT fdcc_status_check
    CHECK (status = ANY (ARRAY['pending', 'settled', 'failed'])),
  CONSTRAINT fdcc_amount_positive CHECK (amount > 0),
  CONSTRAINT fdcc_cycle_tenant_uniq UNIQUE (cycle_month, tenant_id)
);

CREATE INDEX idx_fdcc_tenant ON flex_deposit_custody_charges (tenant_id, cycle_month DESC);
CREATE INDEX idx_fdcc_status ON flex_deposit_custody_charges (status, cycle_month);

-- Feature-flag seed: default visible for UI/UX assessment per S245
-- product decision; flips at launch.
INSERT INTO system_features (key, enabled, description, updated_at)
VALUES (
  'flexdeposit_rollout_visible',
  TRUE,
  'When TRUE, FlexDeposit enrollment surface + installment crons + custody fee cron operate normally. When FALSE, all FlexDeposit endpoints short-circuit and tenant UI hides the product.',
  NOW()
)
ON CONFLICT (key) DO NOTHING;
