-- 10/25 (Nic), correcting the same morning's trailer-bill work.
--
-- THREE THINGS AN INSTALLMENT CONTRACT HAS TO BE ABLE TO SAY FOR ITSELF.
--
-- 1. LATE FEES. I wrote the trailer bill as always late-fee-exempt, on the
--    reasoning that a purchase agreement carries no late terms. Nic:
--
--      "A trailer bill could possibly have late fees. It's an installment
--       contract that may carry its own late terms. I don't have any specific
--       to these contracts, but we need to have the capability for landlords.
--       We provide the tools to do the job, whatever their job is."
--
--    So the contract carries the same stamped late-fee parameters a lease and
--    a utility-service agreement carry, and the bill is exempt only when the
--    contract says there are no fees. DEFAULT OFF: Nic has no late terms on
--    his own contracts, and a fee nobody signed for is never charged
--    (gam-lease-is-law — the document is the charge).
--
-- 2. NO CARD ON THIS BILL. Nic:
--
--      "We need the ability to have the contract flagged as, you know, prevent
--       credit card payments on that bill. That's an exposure where we would
--       have to backtrack bookkeeping and stuff."
--
--    Dominic Gonzalez's installment is the trust's money, not the park's. A
--    card chargeback on it would have to be unwound across two sets of books,
--    so cards are refused on that contract's bills outright. DEFAULT OFF.
--
-- 3. AUTOPAY IS ITS OWN DECISION. Nic:
--
--      "Autopay needs to be toggled on or off per contract per person. If they
--       set up autopay on rent, that will not automatically set up autopay on
--       the trailer payments. They have to go in. The bank account's already
--       linked. It just needs to have a button... Dominic specifically cannot
--       do that because it goes to a different bank account."
--
--    tenant_autopay was one enrollment per LEASE. It becomes one enrollment per
--    lease OR per installment contract — the same "exactly one owner" shape the
--    invoices table carries — so enrolling rent never enrolls the trailer, and
--    the existing runner needs no second implementation.
--
-- Expand-only and re-runnable. No backfill: every existing autopay row keeps
-- its lease, every existing contract comes out with no late fees and cards
-- allowed, which is what each of them does today.

-- ── 1 + 2: the contract's own terms ─────────────────────────────────────────
ALTER TABLE home_sale_contracts
  ADD COLUMN IF NOT EXISTS late_fee_enabled        BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS late_fee_grace_days     INTEGER,
  ADD COLUMN IF NOT EXISTS late_fee_initial_type   TEXT,
  ADD COLUMN IF NOT EXISTS late_fee_initial_amount NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS late_fee_accrual_type   TEXT,
  ADD COLUMN IF NOT EXISTS late_fee_accrual_amount NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS late_fee_accrual_period TEXT,
  ADD COLUMN IF NOT EXISTS late_fee_accrual_from   TEXT,
  ADD COLUMN IF NOT EXISTS late_fee_cap_type       TEXT,
  ADD COLUMN IF NOT EXISTS late_fee_cap_amount     NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS card_payments_blocked   BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN home_sale_contracts.late_fee_enabled IS
  'The signed installment contract charges a late fee. Default FALSE: a fee
   nobody signed for is never charged. The bill is written late_fee_exempt
   while this is false (services/homeSale ownBillFor).';
COMMENT ON COLUMN home_sale_contracts.card_payments_blocked IS
  'Refuse card payments on this contract''s bills (Nic, 10/25). For an
   installment whose money belongs to another set of books — Dominic Gonzalez''s
   goes to the trust — where a chargeback would have to be unwound twice.';

-- The same value sets the lease and the agreement use, so one definition of a
-- late-fee shape governs all three documents.
DO $$
BEGIN
  ALTER TABLE home_sale_contracts
    ADD CONSTRAINT home_sale_contracts_late_fee_initial_type_check
    CHECK (late_fee_initial_type IS NULL OR late_fee_initial_type IN ('flat', 'percent'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
  ALTER TABLE home_sale_contracts
    ADD CONSTRAINT home_sale_contracts_late_fee_accrual_type_check
    CHECK (late_fee_accrual_type IS NULL OR late_fee_accrual_type IN ('flat', 'percent'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
  ALTER TABLE home_sale_contracts
    ADD CONSTRAINT home_sale_contracts_late_fee_accrual_period_check
    CHECK (late_fee_accrual_period IS NULL OR late_fee_accrual_period IN ('daily', 'weekly', 'monthly'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
  ALTER TABLE home_sale_contracts
    ADD CONSTRAINT home_sale_contracts_late_fee_accrual_from_check
    CHECK (late_fee_accrual_from IS NULL OR late_fee_accrual_from IN ('grace_end', 'due_date'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
  ALTER TABLE home_sale_contracts
    ADD CONSTRAINT home_sale_contracts_late_fee_cap_type_check
    CHECK (late_fee_cap_type IS NULL OR late_fee_cap_type IN ('flat', 'percent'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
  ALTER TABLE home_sale_contracts
    ADD CONSTRAINT home_sale_contracts_late_fee_grace_days_check
    CHECK (late_fee_grace_days IS NULL OR late_fee_grace_days >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── 3: autopay belongs to a lease OR an installment contract ───────────────
ALTER TABLE tenant_autopay
  ADD COLUMN IF NOT EXISTS home_sale_contract_id uuid
    REFERENCES home_sale_contracts(id) ON DELETE CASCADE;

ALTER TABLE tenant_autopay ALTER COLUMN lease_id DROP NOT NULL;

COMMENT ON COLUMN tenant_autopay.home_sale_contract_id IS
  'The installment (home/trailer) sale this enrollment pays. Exactly one of
   lease_id / home_sale_contract_id is set: enrolling rent never enrolls the
   trailer payment, and the other way round (Nic, 10/25).';

CREATE UNIQUE INDEX IF NOT EXISTS tenant_autopay_one_per_home_sale
  ON tenant_autopay (home_sale_contract_id)
  WHERE home_sale_contract_id IS NOT NULL;

DO $$
BEGIN
  ALTER TABLE tenant_autopay
    ADD CONSTRAINT tenant_autopay_one_owner
    CHECK ((lease_id IS NOT NULL) <> (home_sale_contract_id IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
