-- 20260430204722_background_check_subsystem.sql
-- Closes "Background-check subsystem audit (deferred S56)".
-- Adds in-house intake schema + provider hand-off cols + applicant pool + match flow.
-- Drops vestigial applicant_name / applicant_email (orphan columns from earlier
-- external-provider-only shape; route code never wrote to them, never used by UI).
--
-- 6-month freshness window: a completed/approved check has expires_at set on
-- the status transition. A daily processor flips past-expiry rows to 'expired'
-- and cascades through the tenant pointer, pool entry, and in-flight matches.
-- After expiration the tenant must submit a new intake to participate again.
--
-- Existing rows in background_checks (if any) used the abandoned shape and a
-- status CHECK that excludes 'submitted' (the only status route code writes),
-- which means no row could have been written by the active route. Any present
-- rows are stale demo data unreferenced by lease_occupants (FK is SET NULL).
-- Wiping is safe and necessary because we are tightening user_id to NOT NULL.

-- 0. Wipe stale rows from the abandoned shape
DELETE FROM background_checks;

-- 1. Drop vestigial NOT NULL columns from the abandoned shape
ALTER TABLE background_checks DROP COLUMN applicant_name;
ALTER TABLE background_checks DROP COLUMN applicant_email;

-- 2. Drop existing status CHECK (will be replaced below with widened set)
ALTER TABLE background_checks DROP CONSTRAINT background_checks_status_check;

-- 3. Add intake + provider + decision + pool-pointer + freshness columns
ALTER TABLE background_checks
  ADD COLUMN tenant_id              uuid REFERENCES tenants(id) ON DELETE SET NULL,
  ADD COLUMN user_id                uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ADD COLUMN first_name             text,
  ADD COLUMN last_name              text,
  ADD COLUMN date_of_birth          date,
  ADD COLUMN ssn_encrypted          text,
  ADD COLUMN ssn_last4              text,
  ADD COLUMN street1                text,
  ADD COLUMN street2                text,
  ADD COLUMN city                   text,
  ADD COLUMN state                  text,
  ADD COLUMN zip                    text,
  ADD COLUMN years_at_address       numeric,
  ADD COLUMN employment_status      text,
  ADD COLUMN employer_name          text,
  ADD COLUMN employer_phone         text,
  ADD COLUMN monthly_income         numeric,
  ADD COLUMN prev_landlord_name     text,
  ADD COLUMN prev_landlord_phone    text,
  ADD COLUMN prev_landlord_email    text,
  ADD COLUMN id_document_url        text,
  ADD COLUMN income_document_urls   jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN consent_credit         boolean NOT NULL DEFAULT FALSE,
  ADD COLUMN consent_criminal       boolean NOT NULL DEFAULT FALSE,
  ADD COLUMN consent_pool           boolean NOT NULL DEFAULT FALSE,
  ADD COLUMN consent_signed_at      timestamptz,
  ADD COLUMN consent_ip             text,
  ADD COLUMN risk_score             integer,
  ADD COLUMN risk_level             text,
  ADD COLUMN risk_flags             jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN ip_address             text,
  ADD COLUMN user_agent             text,
  ADD COLUMN decision_notes         text,
  ADD COLUMN decided_at             timestamptz,
  ADD COLUMN decided_by             uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN provider_name          text NOT NULL DEFAULT 'mock',
  ADD COLUMN applicant_redirect_url text,
  ADD COLUMN webhook_received_at    timestamptz,
  ADD COLUMN report_summary         jsonb,
  ADD COLUMN failure_reason         text,
  ADD COLUMN expires_at             timestamptz,  -- set when status flips to complete or approved
  ADD COLUMN pool_entry_id          uuid,         -- FK constraint added later in this migration
  ADD COLUMN updated_at             timestamptz NOT NULL DEFAULT now();

-- 4. Widened status CHECK (provider stages + tenant-app stages + freshness)
ALTER TABLE background_checks ADD CONSTRAINT background_checks_status_check
  CHECK (status IN (
    'pending','awaiting_applicant','submitted','processing',
    'complete','failed','cancelled','approved','denied','expired'
  ));

-- 5. Risk level CHECK
ALTER TABLE background_checks ADD CONSTRAINT background_checks_risk_level_check
  CHECK (risk_level IS NULL OR risk_level IN ('low','medium','high','very_high'));

-- 6. Indexes for the hot read paths in background.ts + riskScore.ts + daily expiry processor
CREATE INDEX idx_bgc_tenant_id        ON background_checks(tenant_id);
CREATE INDEX idx_bgc_user_id          ON background_checks(user_id);
CREATE INDEX idx_bgc_landlord_id      ON background_checks(landlord_id);
CREATE INDEX idx_bgc_status           ON background_checks(status);
CREATE INDEX idx_bgc_created_desc     ON background_checks(created_at DESC);
CREATE INDEX idx_bgc_ssn_dob          ON background_checks(ssn_last4, date_of_birth);
CREATE INDEX idx_bgc_ip_recent        ON background_checks(ip_address, created_at);
CREATE INDEX idx_bgc_expires_at_active
  ON background_checks(expires_at)
  WHERE status IN ('complete','approved') AND expires_at IS NOT NULL;

-- 7. updated_at trigger (matches convention used elsewhere)
CREATE TRIGGER trg_background_checks_updated_at
  BEFORE UPDATE ON background_checks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- 8. tenants — most-recent pointer + cached status (with freshness terminal)
ALTER TABLE tenants
  ADD COLUMN background_check_id     uuid REFERENCES background_checks(id) ON DELETE SET NULL,
  ADD COLUMN background_check_status text NOT NULL DEFAULT 'not_started';
ALTER TABLE tenants ADD CONSTRAINT tenants_background_check_status_check
  CHECK (background_check_status IN ('not_started','submitted','approved','denied','cancelled','expired'));
CREATE INDEX idx_tenants_bgc_id ON tenants(background_check_id);

-- 9. application_pool — opt-in tenants browsable by landlords
CREATE TABLE application_pool (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  background_check_id uuid NOT NULL REFERENCES background_checks(id) ON DELETE CASCADE,
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status              text NOT NULL DEFAULT 'available',
  consent_pool        boolean NOT NULL DEFAULT TRUE,
  employment_status   text,
  monthly_income      numeric,
  zip                 text,
  city                text,
  state               text,
  lat                 numeric,
  lon                 numeric,
  risk_level          text,
  risk_score          integer,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT application_pool_status_check
    CHECK (status IN ('available','matched','inactive','expired'))
);
CREATE INDEX idx_app_pool_user         ON application_pool(user_id);
CREATE INDEX idx_app_pool_status       ON application_pool(status);
CREATE INDEX idx_app_pool_state        ON application_pool(state) WHERE status = 'available';
CREATE INDEX idx_app_pool_risk_level   ON application_pool(risk_level) WHERE status = 'available';
CREATE INDEX idx_app_pool_created_desc ON application_pool(created_at DESC);
CREATE TRIGGER trg_application_pool_updated_at
  BEFORE UPDATE ON application_pool
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- 10. pool_match_requests — landlord interest + tenant response + paid report unlock
-- A match sits open until tenant responds, withdraws, or the underlying check
-- ages out (cascaded by daily expiry processor). Status set:
-- pending|interested|not_interested|report_purchased|expired.
CREATE TABLE pool_match_requests (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  pool_entry_id     uuid NOT NULL REFERENCES application_pool(id) ON DELETE CASCADE,
  landlord_id       uuid NOT NULL REFERENCES landlords(id) ON DELETE CASCADE,
  unit_id           uuid REFERENCES units(id) ON DELETE SET NULL,
  status            text NOT NULL DEFAULT 'pending',
  landlord_message  text,
  tenant_response   text,
  payment_intent_id text,
  report_fee_paid   boolean NOT NULL DEFAULT FALSE,
  requested_at      timestamptz NOT NULL DEFAULT now(),
  responded_at      timestamptz,
  purchased_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pool_match_requests_status_check
    CHECK (status IN ('pending','interested','not_interested','report_purchased','expired')),
  CONSTRAINT pool_match_requests_unique_landlord_per_entry
    UNIQUE (pool_entry_id, landlord_id)
);
CREATE INDEX idx_pmr_landlord    ON pool_match_requests(landlord_id);
CREATE INDEX idx_pmr_status      ON pool_match_requests(status);
CREATE INDEX idx_pmr_pool_entry  ON pool_match_requests(pool_entry_id);
CREATE TRIGGER trg_pool_match_requests_updated_at
  BEFORE UPDATE ON pool_match_requests
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- 11. tenant_notifications — minimal scaffolding for pool match flow.
-- Full notifications rebuild stays its own deferred session.
CREATE TABLE tenant_notifications (
  id         uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       text NOT NULL,
  title      text NOT NULL,
  body       text,
  data       jsonb,
  read       boolean NOT NULL DEFAULT FALSE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_tnotif_user   ON tenant_notifications(user_id);
CREATE INDEX idx_tnotif_unread ON tenant_notifications(user_id, created_at DESC) WHERE read = FALSE;

-- 12. Deferred FK: background_checks.pool_entry_id -> application_pool(id)
-- (Has to come last because application_pool didn't exist when we added
-- the pool_entry_id column in step 3.)
ALTER TABLE background_checks
  ADD CONSTRAINT background_checks_pool_entry_id_fkey
  FOREIGN KEY (pool_entry_id) REFERENCES application_pool(id) ON DELETE SET NULL;
