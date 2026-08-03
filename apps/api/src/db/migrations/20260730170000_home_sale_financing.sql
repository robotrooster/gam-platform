-- Financed home/RV sale tracking (S568, Nic).
--
-- WHY: parks sell mobile homes / RVs to tenants who then pay SPACE RENT plus a
-- separate amortized HOME PAYMENT (principal − down, at a set interest rate, over
-- N years). The home payment is billed each cycle alongside rent, AUTO-STOPS at
-- the final installment, and on payoff the unit flips landlord-owned → tenant-owned.
--
-- MONEY: the home payment routes to the LANDLORD (the seller), exactly like rent
-- — it's billed as its own payment row (type='home_payment') that rides the
-- invoice and settles through the platform-holds batch (platform_held), so no new
-- money rail is needed. It is NOT type='rent' (that would collide with the
-- (lease_id,due_date) rent-idempotency unique and trigger rent late-fee/eviction
-- logic, which must not apply to a purchase installment).
--
-- Amortization: level monthly payment M = P·r / (1 − (1+r)^−n), r = annual/12.
-- The installment schedule is precomputed at contract creation (principal/interest
-- split per row); the final row absorbs rounding so the balance lands exactly 0.

-- 1) Allow the new payment type (single source of truth: shared PAYMENT_TYPES).
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_type_check;
ALTER TABLE payments ADD CONSTRAINT payments_type_check
  CHECK (type IN ('rent','fee','deposit','utility','float_fee','late_fee','platform_fee','home_payment'));

-- 2) The sale/financing contract. One active contract per unit at a time.
CREATE TABLE home_sale_contracts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id              uuid NOT NULL REFERENCES units(id),
  lease_id             uuid REFERENCES leases(id) ON DELETE SET NULL,
  tenant_id            uuid NOT NULL REFERENCES tenants(id),
  landlord_id          uuid NOT NULL REFERENCES landlords(id),
  sale_price           numeric(12,2) NOT NULL CHECK (sale_price > 0),
  down_payment         numeric(12,2) NOT NULL DEFAULT 0 CHECK (down_payment >= 0),
  financed_amount      numeric(12,2) NOT NULL CHECK (financed_amount >= 0),
  annual_interest_rate numeric(6,3)  NOT NULL DEFAULT 0 CHECK (annual_interest_rate >= 0),  -- percent, e.g. 7.500
  term_months          integer       NOT NULL CHECK (term_months > 0 AND term_months <= 600),
  monthly_payment      numeric(12,2) NOT NULL CHECK (monthly_payment >= 0),
  start_month          date          NOT NULL,   -- first billing cycle (1st of month)
  status               text          NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active','paid_off','cancelled')),
  installments_total   integer       NOT NULL,
  installments_billed  integer       NOT NULL DEFAULT 0,
  installments_paid    integer       NOT NULL DEFAULT 0,
  paid_off_at          timestamptz,
  cancelled_at         timestamptz,
  created_at           timestamptz   NOT NULL DEFAULT now(),
  updated_at           timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX idx_home_sale_contracts_unit ON home_sale_contracts(unit_id);
CREATE INDEX idx_home_sale_contracts_landlord ON home_sale_contracts(landlord_id);
-- At most one ACTIVE financing contract per unit.
CREATE UNIQUE INDEX ux_home_sale_active_per_unit ON home_sale_contracts(unit_id) WHERE status = 'active';

-- 3) The precomputed amortization schedule. billing_month = the cycle it rides.
CREATE TABLE home_sale_installments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id        uuid NOT NULL REFERENCES home_sale_contracts(id) ON DELETE CASCADE,
  installment_number integer NOT NULL,
  billing_month      date    NOT NULL,   -- 1st of the cycle this installment is billed
  amount             numeric(12,2) NOT NULL,
  principal_portion  numeric(12,2) NOT NULL,
  interest_portion   numeric(12,2) NOT NULL,
  remaining_balance  numeric(12,2) NOT NULL,   -- principal balance AFTER this payment
  payment_id         uuid REFERENCES payments(id) ON DELETE SET NULL,  -- stamped when billed
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (contract_id, installment_number)
);
CREATE INDEX idx_home_sale_installments_contract ON home_sale_installments(contract_id);
CREATE INDEX idx_home_sale_installments_unbilled ON home_sale_installments(billing_month) WHERE payment_id IS NULL;

COMMENT ON TABLE home_sale_contracts IS
  'S568: financed sale of a landlord-owned home/RV to a tenant. Space rent stays separate; this is the amortized purchase installment (type=home_payment), auto-stops at term, flips unit to tenant-owned on payoff.';
