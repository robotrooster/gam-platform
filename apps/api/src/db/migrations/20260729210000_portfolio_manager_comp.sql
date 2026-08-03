-- Dual-role portfolio-manager comp + referral keys (S567).
--
-- WHY: a landlord relationship pays a flat 50¢/occupied-unit/month, split into
-- two 25¢ roles that can be held by different portfolio managers:
--   * CLOSING manager (portfolio_manager_id, added in the prior migration) —
--     the rep who won the deal. Earns 25¢/occupied unit residual for as long
--     as the landlord stays on the platform.
--   * SERVICE manager (service_manager_id, added here) — the rep who handles
--     that landlord's customer service. Earns the other 25¢/occupied unit.
-- Same person may hold both roles (full 50¢). Any role left UNSTAFFED accrues
-- its 25¢ into a POT (to_pot rows) for later use — 50¢/occupied unit is always
-- allocated somewhere from day one.
--
-- REFERRAL KEYS: each rep (admin/super_admin) gets a unique referral_code. A
-- landlord who self-registers with that code is auto-attributed to the rep as
-- CLOSING manager — protecting the rep when the landlord signs up on their own
-- instead of through an assisted flow.
--
-- NO BACKFILL: service_manager_id starts NULL (unstaffed → pot); referral_code
-- is generated lazily per rep; commission_accruals starts empty.

-- 1. Service (customer-service) manager role on the landlord.
ALTER TABLE landlords
  ADD COLUMN service_manager_id uuid REFERENCES users(id);

COMMENT ON COLUMN landlords.service_manager_id IS
  'The portfolio manager who handles this landlord''s customer service (25¢/'
  'occupied unit/mo). NULL = unstaffed, that 25¢ accrues to the pot. Distinct '
  'from portfolio_manager_id, which is the CLOSING manager (the other 25¢).';

COMMENT ON COLUMN landlords.portfolio_manager_id IS
  'The CLOSING portfolio manager — the rep who won this deal (25¢/occupied '
  'unit/mo residual). Set via referral code at signup, a claim, or super_admin '
  'assignment. NULL = no closer, that 25¢ accrues to the pot. See '
  'service_manager_id for the customer-service half.';

CREATE INDEX landlords_service_manager_id_idx
  ON landlords (service_manager_id);

-- 2. Per-rep referral code. Unique; NULL for non-reps and un-generated reps.
ALTER TABLE users
  ADD COLUMN referral_code text UNIQUE;

COMMENT ON COLUMN users.referral_code IS
  'Portfolio manager''s personal referral code (S567). A landlord self-'
  'registering with ?ref=<code> is auto-attributed to this rep as CLOSING '
  'manager. Generated lazily; NULL until the rep first requests their link.';

-- 3. Monthly commission accrual ledger — one row per (landlord, month, role).
-- manager_id NULL + to_pot=true means the role was unstaffed and the 25¢ went
-- to the pot. Idempotent re-runs via the unique key.
CREATE TABLE commission_accruals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  accrual_month   date NOT NULL,                       -- first of month
  landlord_id     uuid NOT NULL REFERENCES landlords(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('closing','service')),
  manager_id      uuid REFERENCES users(id),           -- NULL when to_pot
  occupied_units  integer NOT NULL DEFAULT 0,
  rate_per_unit   numeric(10,2) NOT NULL,              -- 0.25
  amount          numeric(10,2) NOT NULL,              -- occupied_units * rate
  to_pot          boolean NOT NULL DEFAULT false,      -- true when unstaffed
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (landlord_id, accrual_month, role)
);

-- Payout roll-ups: by manager (a rep's monthly earnings) and pot (unstaffed).
CREATE INDEX commission_accruals_manager_month_idx
  ON commission_accruals (manager_id, accrual_month);
CREATE INDEX commission_accruals_pot_idx
  ON commission_accruals (accrual_month) WHERE to_pot;
