-- ============================================================
-- GOLD ASSET MANAGEMENT — COMPLETE DATABASE SCHEMA
-- PostgreSQL
-- ============================================================

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── USERS ────────────────────────────────────────────────────

CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','landlord','tenant')),
  first_name    TEXT NOT NULL,
  last_name     TEXT NOT NULL,
  phone         TEXT,
  email_verified BOOLEAN DEFAULT FALSE,
  email_verify_token TEXT,
  reset_token   TEXT,
  reset_token_expires TIMESTAMPTZ,
  last_login_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── LANDLORDS ────────────────────────────────────────────────

CREATE TABLE landlords (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_name        TEXT,
  ein                  TEXT,                           -- Encrypted in app layer
  stripe_account_id    TEXT,                           -- Stripe Connect
  stripe_bank_verified BOOLEAN DEFAULT FALSE,
  onboarding_complete  BOOLEAN DEFAULT FALSE,
  volume_tier          TEXT DEFAULT 'standard'         -- standard/growth/professional/enterprise/partner
    CHECK (volume_tier IN ('standard','growth','professional','enterprise','partner')),
  annual_contract      BOOLEAN DEFAULT FALSE,
  notes                TEXT,
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ DEFAULT NOW()
);

-- ── TENANTS ──────────────────────────────────────────────────

CREATE TABLE tenants (
  id                           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id                      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stripe_customer_id           TEXT,
  ach_verified                 BOOLEAN DEFAULT FALSE,
  bank_last4                   TEXT,
  bank_routing_last4           TEXT,
  ssi_ssdi                     BOOLEAN DEFAULT FALSE,
  income_arrival_day           INTEGER CHECK (income_arrival_day BETWEEN 1 AND 28),
  on_time_pay_enrolled         BOOLEAN DEFAULT FALSE,  -- Float service opt-in
  float_fee_active             BOOLEAN DEFAULT FALSE,  -- $20/mo active
  credit_reporting_enrolled    BOOLEAN DEFAULT FALSE,
  flex_deposit_enrolled        BOOLEAN DEFAULT FALSE,
  late_payment_count           INTEGER DEFAULT 0,
  on_time_pay_invite_sent_at   TIMESTAMPTZ,            -- Invite sent after 2 late payments
  created_at                   TIMESTAMPTZ DEFAULT NOW(),
  updated_at                   TIMESTAMPTZ DEFAULT NOW()
);

-- ── PROPERTIES ───────────────────────────────────────────────

CREATE TABLE properties (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  landlord_id UUID NOT NULL REFERENCES landlords(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  street1     TEXT NOT NULL,
  street2     TEXT,
  city        TEXT NOT NULL,
  state       TEXT NOT NULL DEFAULT 'AZ',
  zip         TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'residential'
    CHECK (type IN ('residential','rv_longterm','rv_weekly','rv_nightly')),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── UNITS ────────────────────────────────────────────────────

CREATE TABLE units (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  property_id       UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  landlord_id       UUID NOT NULL REFERENCES landlords(id),
  tenant_id         UUID REFERENCES tenants(id),
  unit_number       TEXT NOT NULL,
  bedrooms          INTEGER NOT NULL DEFAULT 1,
  bathrooms         DECIMAL(3,1) NOT NULL DEFAULT 1.0,
  sqft              INTEGER,
  status            TEXT NOT NULL DEFAULT 'vacant'
    CHECK (status IN ('active','direct_pay','vacant','delinquent','suspended')),
  rent_amount       DECIMAL(10,2) NOT NULL,
  security_deposit  DECIMAL(10,2) NOT NULL DEFAULT 0,
  on_time_pay_active BOOLEAN DEFAULT FALSE,
  payment_block     BOOLEAN DEFAULT FALSE,             -- Eviction mode — ARS 33-1371
  payment_block_set_at TIMESTAMPTZ,
  payment_block_set_by UUID REFERENCES users(id),
  listed_vacant     BOOLEAN DEFAULT TRUE,              -- Auto-list vacant units
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (property_id, unit_number)
);

-- ── LEASES ───────────────────────────────────────────────────

CREATE TABLE leases (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  unit_id          UUID NOT NULL REFERENCES units(id),
  tenant_id        UUID NOT NULL REFERENCES tenants(id),
  landlord_id      UUID NOT NULL REFERENCES landlords(id),
  status           TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','active','expired','terminated')),
  start_date       DATE NOT NULL,
  end_date         DATE NOT NULL,
  rent_amount      DECIMAL(10,2) NOT NULL,
  rent_due_day     INTEGER NOT NULL DEFAULT 1,
  security_deposit DECIMAL(10,2) NOT NULL DEFAULT 0,
  late_fee_grace_days  INTEGER DEFAULT 5,
  late_fee_amount      DECIMAL(10,2) DEFAULT 15.00,
  signed_by_landlord   BOOLEAN DEFAULT FALSE,
  signed_by_tenant     BOOLEAN DEFAULT FALSE,
  signed_at            TIMESTAMPTZ,
  terminated_at        TIMESTAMPTZ,
  termination_reason   TEXT,
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ DEFAULT NOW()
);

-- ── PAYMENTS ─────────────────────────────────────────────────

CREATE TABLE payments (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  unit_id                 UUID REFERENCES units(id),
  lease_id                UUID REFERENCES leases(id),
  tenant_id               UUID REFERENCES tenants(id),
  landlord_id             UUID NOT NULL REFERENCES landlords(id),
  type                    TEXT NOT NULL
    CHECK (type IN ('rent','fee','deposit','utility','float_fee','late_fee','platform_fee')),
  amount                  DECIMAL(10,2) NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','settled','failed','returned')),
  stripe_payment_intent_id TEXT,
  stripe_charge_id         TEXT,
  ach_trace_number         TEXT,
  entry_description        TEXT NOT NULL               -- RENT/SUBSCRIP/DEPOSIT/UTILITY/ONTIMEPAY
    CHECK (entry_description IN ('RENT','SUBSCRIP','DEPOSIT','UTILITY','ONTIMEPAY')),
  return_code              TEXT,
  return_reason            TEXT,
  zero_tolerance_flag      BOOLEAN DEFAULT FALSE,       -- R05/R07/R10/R29
  due_date                 DATE NOT NULL,
  processed_at             TIMESTAMPTZ,
  settled_at               TIMESTAMPTZ,
  retry_count              INTEGER DEFAULT 0,
  notes                    TEXT,
  created_at               TIMESTAMPTZ DEFAULT NOW()
);

-- ── DISBURSEMENTS ────────────────────────────────────────────

CREATE TABLE disbursements (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  landlord_id         UUID NOT NULL REFERENCES landlords(id),
  amount              DECIMAL(10,2) NOT NULL,
  unit_count          INTEGER NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','settled','failed')),
  stripe_payout_id    TEXT,
  from_reserve        BOOLEAN DEFAULT FALSE,           -- SLA funded from reserve
  reserve_amount      DECIMAL(10,2) DEFAULT 0,
  -- SLA: initiated on or before 1st business day of month
  target_date         DATE NOT NULL,
  initiated_at        TIMESTAMPTZ,
  settled_at          TIMESTAMPTZ,
  notes               TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ── RESERVE FUND ─────────────────────────────────────────────

CREATE TABLE reserve_fund_ledger (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  type            TEXT NOT NULL
    CHECK (type IN ('contribution','disbursement_cover','replenishment','interest','adjustment')),
  amount          DECIMAL(10,2) NOT NULL,              -- Positive = in, negative = out
  balance_after   DECIMAL(10,2) NOT NULL,
  reference_id    UUID,                                -- disbursement_id or payment_id
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE reserve_fund_state (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  balance              DECIMAL(10,2) NOT NULL DEFAULT 0,
  target_balance       DECIMAL(10,2) NOT NULL DEFAULT 0,
  phase                INTEGER NOT NULL DEFAULT 1 CHECK (phase IN (1,2,3)),
  reserve_rate         DECIMAL(5,4) NOT NULL DEFAULT 1.00,
  monthly_contribution DECIMAL(10,2) DEFAULT 0,
  updated_at           TIMESTAMPTZ DEFAULT NOW()
);

-- ── FLOAT ACCOUNT ────────────────────────────────────────────

CREATE TABLE float_account_state (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  balance          DECIMAL(10,2) NOT NULL DEFAULT 25000, -- $25K seed
  seed_capital     DECIMAL(10,2) NOT NULL DEFAULT 25000,
  apy              DECIMAL(5,4) NOT NULL DEFAULT 0.045,
  monthly_interest DECIMAL(10,2) DEFAULT 0,
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ── SECURITY DEPOSITS ────────────────────────────────────────

CREATE TABLE security_deposits (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  unit_id               UUID NOT NULL REFERENCES units(id),
  lease_id              UUID NOT NULL REFERENCES leases(id),
  tenant_id             UUID NOT NULL REFERENCES tenants(id),
  total_amount          DECIMAL(10,2) NOT NULL,
  collected_amount      DECIMAL(10,2) NOT NULL DEFAULT 0,
  status                TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','funded','partial','disbursed','claimed')),
  flex_deposit_enabled  BOOLEAN DEFAULT FALSE,
  installment_count     INTEGER,
  installment_amount    DECIMAL(10,2),
  installments_paid     INTEGER DEFAULT 0,
  installments_remaining INTEGER,
  next_installment_date DATE,
  interest_accrued      DECIMAL(10,2) DEFAULT 0,       -- Platform keeps per ARS 33-1321
  disbursed_to_landlord DECIMAL(10,2) DEFAULT 0,
  disbursed_at          TIMESTAMPTZ,
  damage_claimed        DECIMAL(10,2) DEFAULT 0,
  notes                 TEXT,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

-- ── MAINTENANCE ───────────────────────────────────────────────

CREATE TABLE contractors (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name                TEXT NOT NULL,
  business_name       TEXT NOT NULL,
  phone               TEXT NOT NULL,
  email               TEXT UNIQUE NOT NULL,
  azroc_license       TEXT NOT NULL,                   -- AZ Registrar of Contractors — required
  insurance_verified  BOOLEAN DEFAULT FALSE,
  insurance_expiry    DATE,
  listing_tier        TEXT CHECK (listing_tier IN ('featured','premium','exclusive')),
  listing_fee         DECIMAL(10,2),
  trades              TEXT[] DEFAULT '{}',
  rating              DECIMAL(3,2),
  completed_jobs      INTEGER DEFAULT 0,
  active              BOOLEAN DEFAULT TRUE,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE maintenance_requests (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  unit_id         UUID NOT NULL REFERENCES units(id),
  tenant_id       UUID REFERENCES tenants(id),
  landlord_id     UUID NOT NULL REFERENCES landlords(id),
  contractor_id   UUID REFERENCES contractors(id),
  title           TEXT NOT NULL,
  description     TEXT NOT NULL,
  priority        TEXT NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('emergency','high','normal','low')),
  status          TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','assigned','in_progress','completed','cancelled')),
  estimated_cost  DECIMAL(10,2),
  actual_cost     DECIMAL(10,2),
  platform_fee    DECIMAL(10,2),                       -- 8% of actual_cost
  scheduled_at    TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  photos          TEXT[] DEFAULT '{}',
  tenant_notes    TEXT,
  landlord_notes  TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── UTILITY BILLING ───────────────────────────────────────────

CREATE TABLE utility_bills (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  unit_id          UUID NOT NULL REFERENCES units(id),
  tenant_id        UUID NOT NULL REFERENCES tenants(id),
  utility_type     TEXT NOT NULL,                      -- electricity/water/gas/sewer
  opening_reading  DECIMAL(12,4) NOT NULL,
  closing_reading  DECIMAL(12,4) NOT NULL,
  opening_date     DATE NOT NULL,
  closing_date     DATE NOT NULL,
  usage_amount     DECIMAL(12,4) NOT NULL,
  rate_per_unit    DECIMAL(10,6) NOT NULL,
  utility_cost     DECIMAL(10,2) NOT NULL,
  admin_fee        DECIMAL(10,2) NOT NULL DEFAULT 0,   -- AZ: actual cost + admin fee ONLY
  total_amount     DECIMAL(10,2) NOT NULL,
  payment_id       UUID REFERENCES payments(id),
  status           TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','settled','failed')),
  billed_at        DATE NOT NULL,
  due_date         DATE NOT NULL,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ── DOCUMENTS ────────────────────────────────────────────────

CREATE TABLE documents (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  lease_id     UUID REFERENCES leases(id),
  unit_id      UUID REFERENCES units(id),
  tenant_id    UUID REFERENCES tenants(id),
  landlord_id  UUID NOT NULL REFERENCES landlords(id),
  type         TEXT NOT NULL
    CHECK (type IN ('lease','addendum','move_in_checklist','move_out_checklist','notice','other')),
  name         TEXT NOT NULL,
  url          TEXT NOT NULL,                          -- S3 or storage URL
  file_size    INTEGER,
  mime_type    TEXT,
  signed_by_tenant   BOOLEAN DEFAULT FALSE,
  signed_by_landlord BOOLEAN DEFAULT FALSE,
  signed_at    TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ── BACKGROUND CHECKS ────────────────────────────────────────

CREATE TABLE background_checks (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  unit_id         UUID REFERENCES units(id),
  landlord_id     UUID NOT NULL REFERENCES landlords(id),
  applicant_name  TEXT NOT NULL,
  applicant_email TEXT NOT NULL,
  amount_charged  DECIMAL(10,2) DEFAULT 40.00,         -- Applicant pays $40
  platform_net    DECIMAL(10,2) DEFAULT 15.00,         -- Platform nets $15
  provider_ref    TEXT,                                 -- Provider reference ID
  status          TEXT DEFAULT 'pending'
    CHECK (status IN ('pending','processing','complete','failed')),
  result_url      TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── NACHA FRAUD MONITORING (Phase 2 — June 22, 2026) ─────────

CREATE TABLE ach_monitoring_log (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  payment_id      UUID REFERENCES payments(id),
  event_type      TEXT NOT NULL
    CHECK (event_type IN ('first_sender','velocity_flag','return_received','zero_tolerance_block')),
  tenant_id       UUID REFERENCES tenants(id),
  bank_fingerprint TEXT,                               -- Hashed routing+account
  amount          DECIMAL(10,2),
  return_code     TEXT,
  flagged         BOOLEAN DEFAULT FALSE,
  resolved        BOOLEAN DEFAULT FALSE,
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── NOTIFICATIONS ─────────────────────────────────────────────

CREATE TABLE notifications (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id),
  type        TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  read        BOOLEAN DEFAULT FALSE,
  action_url  TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── AUDIT LOG ────────────────────────────────────────────────

CREATE TABLE audit_log (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID REFERENCES users(id),
  action      TEXT NOT NULL,
  entity_type TEXT,
  entity_id   UUID,
  old_value   JSONB,
  new_value   JSONB,
  ip_address  TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── INDEXES ───────────────────────────────────────────────────

CREATE INDEX idx_users_email          ON users(email);
CREATE INDEX idx_landlords_user_id    ON landlords(user_id);
CREATE INDEX idx_tenants_user_id      ON tenants(user_id);
CREATE INDEX idx_properties_landlord  ON properties(landlord_id);
CREATE INDEX idx_units_property       ON units(property_id);
CREATE INDEX idx_units_landlord       ON units(landlord_id);
CREATE INDEX idx_units_tenant         ON units(tenant_id);
CREATE INDEX idx_units_status         ON units(status);
CREATE INDEX idx_leases_unit          ON leases(unit_id);
CREATE INDEX idx_leases_tenant        ON leases(tenant_id);
CREATE INDEX idx_payments_unit        ON payments(unit_id);
CREATE INDEX idx_payments_tenant      ON payments(tenant_id);
CREATE INDEX idx_payments_landlord    ON payments(landlord_id);
CREATE INDEX idx_payments_status      ON payments(status);
CREATE INDEX idx_payments_due_date    ON payments(due_date);
CREATE INDEX idx_disbursements_landlord ON disbursements(landlord_id);
CREATE INDEX idx_disbursements_target   ON disbursements(target_date);
CREATE INDEX idx_maintenance_unit     ON maintenance_requests(unit_id);
CREATE INDEX idx_maintenance_status   ON maintenance_requests(status);
CREATE INDEX idx_notifications_user   ON notifications(user_id, read);
CREATE INDEX idx_audit_entity         ON audit_log(entity_type, entity_id);

-- ── UPDATED_AT TRIGGER ────────────────────────────────────────

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated_at       BEFORE UPDATE ON users        FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_landlords_updated_at   BEFORE UPDATE ON landlords    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_tenants_updated_at     BEFORE UPDATE ON tenants      FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_properties_updated_at  BEFORE UPDATE ON properties   FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_units_updated_at       BEFORE UPDATE ON units        FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_leases_updated_at      BEFORE UPDATE ON leases       FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_maintenance_updated_at BEFORE UPDATE ON maintenance_requests FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_deposits_updated_at    BEFORE UPDATE ON security_deposits    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
