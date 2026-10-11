-- S645 — WHO PAYS GAM, AND WHO THE MANAGER RE-BILLS.
--
-- Nic (S645, DIRECTIVE): "Make that a toggle feature — who pays the platform.
-- Make that be able to be passed through between either the property manager,
-- if they're including that in their contract, or if it's getting passed
-- through to the owner. I'm assuming most people will choose to have it
-- included in the contract — they've priced in software to do their business.
-- But in case anybody wants to pass it through, it lets the owner know exactly
-- where part of that money is going."
--
-- And on the manager marking it up, after talking himself out of objecting:
-- "If we're giving somebody, on 11,000 units, 50 cents a unit — maybe he wants
-- to charge a dollar a unit to the owner. We're billing them $5,500 and they're
-- billing the owners collectively at $11,000. They're making a profit there
-- before any percentages of rent. We're making a profit there. It's not as much,
-- but the property manager is the one to incentivize, because they're operating
-- the portfolio."
--
-- SAFE TO BUILD GREENFIELD: no property in production has a pm_company_id yet,
-- so none of this changes an existing bill. It only governs properties that
-- join a manager from here on.

-- ── 1. THE TOGGLE, ON THE RELATIONSHIP ────────────────────────────────────
--
-- Per (manager, owner), because it is a term of their contract with each
-- other and an owner with six parks under one manager agreed it once.
ALTER TABLE pm_owner_relationships
  ADD COLUMN IF NOT EXISTS platform_fee_payer text NOT NULL DEFAULT 'pm_company'
    CHECK (platform_fee_payer IN ('pm_company','owner')),
  -- What the MANAGER charges the owner per occupied unit when passing it
  -- through. NULL means "exactly what GAM charges us" — no markup, which is
  -- the honest default for a manager who just wants to be made whole.
  ADD COLUMN IF NOT EXISTS platform_fee_rate_to_owner numeric(10,2)
    CHECK (platform_fee_rate_to_owner IS NULL OR platform_fee_rate_to_owner >= 0);

-- ── 2. GAM'S RATE TO A MANAGER ────────────────────────────────────────────
--
-- The bulk deal. landlord_platform_fee_overrides already does this for a
-- landlord, and a manager is a different kind of customer: 11,000 units under
-- one contract is not the list rate, and the rate follows the MANAGER across
-- every owner they bring, not any one owner's portfolio.
CREATE TABLE IF NOT EXISTS pm_company_platform_fee_overrides (
  id                       uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  pm_company_id            uuid NOT NULL REFERENCES pm_companies(id) ON DELETE CASCADE,
  rate_per_unit            numeric(10,2) NOT NULL CHECK (rate_per_unit >= 0),
  min_per_connect_account  numeric(10,2),
  effective_from           date NOT NULL DEFAULT CURRENT_DATE,
  effective_until          date,
  set_by_user_id           uuid REFERENCES users(id),
  reason                   text,
  created_at               timestamptz NOT NULL DEFAULT now()
);
-- One live rate per manager at a time, the same shape the landlord override uses.
CREATE UNIQUE INDEX IF NOT EXISTS ux_pm_company_fee_override_live
  ON pm_company_platform_fee_overrides (pm_company_id)
  WHERE effective_until IS NULL;

-- ── 3. GAM BILLS THE MANAGER, NOT THE OWNER ───────────────────────────────
--
-- Nic (S644, DIRECTIVE): "The PM company — one bill." When this is set, the
-- accrual is still ATTRIBUTED to the owner's property (that is where the units
-- are, and the owner's statement needs to know) but the INVOICE goes to the
-- manager. Keeping landlord_id populated is what lets one bill be broken down
-- by owner without a second table.
ALTER TABLE platform_fee_accruals
  ADD COLUMN IF NOT EXISTS billed_pm_company_id uuid REFERENCES pm_companies(id);
CREATE INDEX IF NOT EXISTS idx_platform_fee_accruals_billed_pm
  ON platform_fee_accruals (billed_pm_company_id, accrual_month DESC)
  WHERE billed_pm_company_id IS NOT NULL;

-- ── 4. WHAT THE MANAGER RE-BILLS THE OWNER ────────────────────────────────
--
-- Its own table rather than another pm_monthly_fee_accruals row, for two
-- reasons. The unique key there is one row per (property, month, manager), so
-- there is no space for a second kind of charge. And more importantly this is
-- NOT management revenue — it is a software cost being handed on — and Nic's
-- whole reason for the toggle is that the owner can see exactly what it is.
-- Folding it into the management fee would hide the thing he wants shown.
--
-- gam_rate_per_unit is recorded for GAM's own margin reporting and is NEVER
-- shown to an owner: quoting our cost next to the manager's price would price
-- the manager's business for them in front of their customer.
CREATE TABLE IF NOT EXISTS pm_platform_fee_passthroughs (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  pm_company_id       uuid NOT NULL REFERENCES pm_companies(id) ON DELETE CASCADE,
  landlord_id         uuid NOT NULL REFERENCES landlords(id)    ON DELETE CASCADE,
  property_id         uuid NOT NULL REFERENCES properties(id)   ON DELETE CASCADE,
  accrual_month       date NOT NULL,
  occupied_unit_count integer NOT NULL CHECK (occupied_unit_count >= 0),
  rate_per_unit       numeric(10,2) NOT NULL CHECK (rate_per_unit >= 0),
  total_amount        numeric(12,2) NOT NULL CHECK (total_amount >= 0),
  gam_rate_per_unit   numeric(10,2),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, accrual_month, pm_company_id)
);
CREATE INDEX IF NOT EXISTS idx_pm_passthrough_statement
  ON pm_platform_fee_passthroughs (landlord_id, accrual_month);
