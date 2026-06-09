-- S252: FlexCharge schema — consolidated POS charge-account product.
--
-- FlexCharge lets a POS merchant ("user" — landlord OR standalone POS
-- operator) extend a credit-line tab to known customers (tenants OR
-- pos_customers) at one of their properties. Customer accumulates
-- POS-item charges over the month → monthly statement → ACH-pull of
-- statement balance plus a 1.5% service fee (FLEX_CHARGE_STATEMENT_FEE_PCT
-- in shared). No interest. No revolving balance. Auto-pay required.
-- This keeps the product clearly classed as deferred-debit, not credit
-- extension — staying out of payday-lending regulatory territory.
--
-- ── Product spec confirmed S252 ────────────────────────────────────
-- Q1 fee model:    1.5% of statement balance + ACH cost.
--                  No per-tx markup. No interest.
-- Q2 credit limit: property-level default, set by POS user; new
--                  accounts inherit, can be overridden per-account.
-- Q3 statement:    monthly; ACH auto-pull of balance + 1.5%.
-- Q4 charge scope: only POS items where pos_items.charge_eligible=TRUE.
--                  Never platform fees, BG checks, deposits.
-- Q5 audience:     not gated to property type; requires linked
--                  tenant OR pos_customer with ACH on file.
-- Q6 dispute:      any dispute (chargeback OR in-app) → tenant
--                  permanent disqualification. Multi-dispute pattern
--                  against same POS user → user-level cutoff. (S253
--                  builds the disqualification engine — schema is
--                  ready.)
--
-- ── Tables ─────────────────────────────────────────────────────────
-- pos_customers           — merchant-owned customer roster for non-
--                            tenants. Tenants reuse their tenants row.
-- flex_charge_accounts    — per (customer, property) FlexCharge tab.
-- flex_charge_transactions — per POS charge against a tab.
-- flex_charge_statements  — monthly cycle aggregation + ACH-pull row.

-- ── pos_customers ──────────────────────────────────────────────────
-- Merchants maintain their own customer roster for non-tenant POS
-- users. Email is the natural unique-per-merchant key; ACH verification
-- happens via the same Stripe Customer + SetupIntent pattern tenants use.

CREATE TABLE pos_customers (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  landlord_id         uuid NOT NULL REFERENCES landlords(id),
  first_name          text NOT NULL,
  last_name           text NOT NULL,
  email               text NOT NULL,
  phone               text,
  stripe_customer_id  text,
  ach_verified        boolean NOT NULL DEFAULT false,
  bank_last4          text,
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT NOW(),
  updated_at          timestamptz NOT NULL DEFAULT NOW(),
  archived_at         timestamptz
);

-- Function-based unique requires a separate UNIQUE INDEX (PostgreSQL
-- doesn't allow expressions inside CREATE TABLE UNIQUE constraints).
CREATE UNIQUE INDEX pos_customers_email_landlord_uniq
  ON pos_customers (landlord_id, LOWER(email));

CREATE INDEX idx_pos_customers_landlord ON pos_customers (landlord_id) WHERE archived_at IS NULL;
CREATE INDEX idx_pos_customers_email    ON pos_customers (LOWER(email));

-- ── pos_transactions.pos_customer_id ───────────────────────────────
-- A POS sale to a non-tenant FlexCharge customer points here instead
-- of (or alongside) tenant_id. Either tenant_id or pos_customer_id
-- may be set; both NULL = anonymous walk-up sale (no FlexCharge).

ALTER TABLE pos_transactions
  ADD COLUMN pos_customer_id uuid REFERENCES pos_customers(id);

CREATE INDEX idx_pos_transactions_pos_customer
  ON pos_transactions (pos_customer_id) WHERE pos_customer_id IS NOT NULL;

-- ── flex_charge_accounts ───────────────────────────────────────────
-- One row per (customer, property) FlexCharge enrollment. Customer can
-- be a tenant (tenant_id set) OR a pos_customer (pos_customer_id set).
-- XOR check ensures exactly one is populated.
--
-- credit_limit defaults from the property's flex_charge_default_credit_limit
-- at create time; override per-account if needed.
--
-- status: active | suspended | disqualified
--   active        — normal operation
--   suspended     — manual hold by POS user (e.g., billing issue);
--                   can be re-activated
--   disqualified  — permanent dispute-driven cutoff;
--                   disqualified_until set for cooldown semantics
--                   (S253 NSF / dispute engine flips this)

CREATE TABLE flex_charge_accounts (
  id                   uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id            uuid REFERENCES tenants(id),
  pos_customer_id      uuid REFERENCES pos_customers(id),
  property_id          uuid NOT NULL REFERENCES properties(id),
  landlord_id          uuid NOT NULL REFERENCES landlords(id),
  credit_limit         numeric(10,2) NOT NULL,
  status               text NOT NULL DEFAULT 'active',
  disqualified_until   timestamptz,
  disqualified_reason  text,
  notes                text,
  created_at           timestamptz NOT NULL DEFAULT NOW(),
  updated_at           timestamptz NOT NULL DEFAULT NOW(),

  CONSTRAINT flex_charge_accounts_status_check
    CHECK (status = ANY (ARRAY['active', 'suspended', 'disqualified'])),
  CONSTRAINT flex_charge_accounts_customer_xor
    CHECK (
      (tenant_id IS NOT NULL AND pos_customer_id IS NULL)
      OR
      (tenant_id IS NULL AND pos_customer_id IS NOT NULL)
    ),
  CONSTRAINT flex_charge_accounts_credit_limit_nonneg
    CHECK (credit_limit >= 0)
);

-- One account per customer per property.
CREATE UNIQUE INDEX flex_charge_accounts_tenant_property_uniq
  ON flex_charge_accounts (tenant_id, property_id)
  WHERE tenant_id IS NOT NULL;
CREATE UNIQUE INDEX flex_charge_accounts_pos_customer_property_uniq
  ON flex_charge_accounts (pos_customer_id, property_id)
  WHERE pos_customer_id IS NOT NULL;

CREATE INDEX idx_flex_charge_accounts_property ON flex_charge_accounts (property_id);
CREATE INDEX idx_flex_charge_accounts_landlord ON flex_charge_accounts (landlord_id);
CREATE INDEX idx_flex_charge_accounts_status   ON flex_charge_accounts (status);

-- ── flex_charge_transactions ───────────────────────────────────────
-- One row per POS charge against the FlexCharge account. Linked to the
-- underlying pos_transactions row (which has the receipt + items +
-- amount). Status lifecycle:
--   pending   — charge posted, not yet on a statement
--   billed    — included in a statement that's been cut
--   paid      — statement settled via ACH pull
--   disputed  — customer raised a dispute (S253 engine sets account
--               disqualified)
--   refunded  — POS-level refund undid this transaction; balance
--               adjusted out of next cycle

CREATE TABLE flex_charge_transactions (
  id                 uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id         uuid NOT NULL REFERENCES flex_charge_accounts(id),
  pos_transaction_id uuid REFERENCES pos_transactions(id),
  statement_id       uuid,
  amount             numeric(10,2) NOT NULL,
  status             text NOT NULL DEFAULT 'pending',
  disputed_at        timestamptz,
  dispute_reason     text,
  refunded_at        timestamptz,
  notes              text,
  created_at         timestamptz NOT NULL DEFAULT NOW(),
  updated_at         timestamptz NOT NULL DEFAULT NOW(),

  CONSTRAINT flex_charge_tx_status_check
    CHECK (status = ANY (ARRAY['pending', 'billed', 'paid', 'disputed', 'refunded'])),
  CONSTRAINT flex_charge_tx_amount_nonzero CHECK (amount <> 0)
);

CREATE INDEX idx_flex_charge_tx_account   ON flex_charge_transactions (account_id, created_at DESC);
CREATE INDEX idx_flex_charge_tx_statement ON flex_charge_transactions (statement_id) WHERE statement_id IS NOT NULL;
CREATE INDEX idx_flex_charge_tx_status    ON flex_charge_transactions (status);
CREATE INDEX idx_flex_charge_tx_pos       ON flex_charge_transactions (pos_transaction_id) WHERE pos_transaction_id IS NOT NULL;

-- ── flex_charge_statements ─────────────────────────────────────────
-- Monthly cycle aggregation per account. balance = sum of pending
-- transactions at cycle close; service_fee = balance * 1.5%; total_due
-- = balance + service_fee. ACH-pull payment row linked via payment_id
-- when billing fires (S253).
--
-- UNIQUE (account_id, cycle_month) — at most one statement per cycle.

CREATE TABLE flex_charge_statements (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id    uuid NOT NULL REFERENCES flex_charge_accounts(id),
  cycle_month   date NOT NULL,
  balance       numeric(10,2) NOT NULL,
  service_fee   numeric(10,2) NOT NULL,
  total_due     numeric(10,2) NOT NULL,
  due_date      date NOT NULL,
  status        text NOT NULL DEFAULT 'open',
  payment_id    uuid REFERENCES payments(id),
  billed_at     timestamptz,
  settled_at    timestamptz,
  failed_reason text,
  created_at    timestamptz NOT NULL DEFAULT NOW(),
  updated_at    timestamptz NOT NULL DEFAULT NOW(),

  CONSTRAINT flex_charge_stmt_status_check
    CHECK (status = ANY (ARRAY['open', 'billed', 'paid', 'failed', 'voided'])),
  CONSTRAINT flex_charge_stmt_balance_nonneg
    CHECK (balance >= 0 AND service_fee >= 0 AND total_due >= 0),
  CONSTRAINT flex_charge_stmt_cycle_account_uniq UNIQUE (account_id, cycle_month)
);

CREATE INDEX idx_flex_charge_stmt_account ON flex_charge_statements (account_id, cycle_month DESC);
CREATE INDEX idx_flex_charge_stmt_status  ON flex_charge_statements (status, due_date);

-- Back-reference: flex_charge_transactions.statement_id → statements
ALTER TABLE flex_charge_transactions
  ADD CONSTRAINT flex_charge_tx_statement_fk
    FOREIGN KEY (statement_id) REFERENCES flex_charge_statements(id);

-- ── properties.flex_charge_default_credit_limit ────────────────────
-- Property-level default credit limit for new FlexCharge accounts
-- created at this property. POS user sets this; new accounts inherit;
-- per-account override possible via the credit_limit column above.

ALTER TABLE properties
  ADD COLUMN flex_charge_default_credit_limit numeric(10,2) NOT NULL DEFAULT 500.00;

-- ── Feature flag ───────────────────────────────────────────────────
INSERT INTO system_features (key, enabled, description, updated_at)
VALUES (
  'flexcharge_rollout_visible',
  TRUE,
  'When TRUE, FlexCharge enrollment surfaces (landlord pos_customers + flex_charge_accounts management, tenant view, POS payment flow) operate normally. When FALSE, all FlexCharge endpoints short-circuit and UI hides the product.',
  NOW()
)
ON CONFLICT (key) DO NOTHING;
