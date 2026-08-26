-- S624 (Nic) — the tenant tells us they paid at the bank, and the BANK confirms it.
--
-- The problem this closes: a tenant who pays their own rent at a branch leaves
-- the landlord to reconstruct the whole event by hand — find the deposit, work
-- out which tenant it was, waive the late fee that accrued while it was in
-- transit, credit it back, mark the charges paid, and unwind all of it if a
-- check bounces. Where every unit is submetered the amounts usually identify
-- the payer on their own, but where utilities are included in a flat rent they
-- do not, and Nic asked for "an option that gives the landlord minimal work to
-- do" in that case. The least work possible is none, and this is how you get
-- there: the tenant asserts, the bank verifies, GAM reconciles the two.
--
-- WHY A DECLARATION IS NOT A PAYMENT — and this is the whole anti-fraud design.
--
-- Nic: "it also needs a way to have protections in case the tenant just straight
-- up lied and said they paid, and they never actually went to the bank."
--
-- A row here changes NOTHING. No credit, no balance movement, no pause on late
-- fees, no effect on the eviction clock. It is a claim awaiting evidence. When a
-- matching bank transaction arrives, the payment is recorded BACKDATED to the
-- bank's posted date and any late fee that accrued after that date is refunded —
-- so an honest tenant is made whole for the bank's lag, and a dishonest one wins
-- exactly nothing. Removing the prize is a better defence than trying to detect
-- the lie.
--
-- `method` is here because Nic asked for it and it earns its place: a bank memo
-- describes the INSTRUMENT even when it names nobody, and a mobile deposit is a
-- check by definition — you cannot photograph cash. Two tenants claiming the
-- same figure are usually separable on that alone.

CREATE TABLE IF NOT EXISTS tenant_declared_deposits (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id)   ON DELETE CASCADE,
  lease_id      uuid NOT NULL REFERENCES leases(id)    ON DELETE CASCADE,
  landlord_id   uuid NOT NULL REFERENCES landlords(id) ON DELETE RESTRICT,

  amount        numeric(12,2) NOT NULL,
  -- The date the TENANT says they went to the bank. Never used as the payment
  -- date: the bank's own posted date is, because that is the fact.
  declared_date date NOT NULL,
  method        text NOT NULL,
  -- Free text from the tenant — a check number, a branch, anything that helps a
  -- human resolve a tie the machine could not.
  reference     text,

  -- pending     — claimed, waiting for a bank row. Affects nothing.
  -- confirmed   — a bank deposit matched; the payment was recorded.
  -- unconfirmed — the window passed with no matching deposit. Surfaced to the
  --               landlord, and counted against the tenant.
  -- withdrawn   — the tenant took it back.
  status        text NOT NULL DEFAULT 'pending',

  bank_transaction_id uuid REFERENCES bank_transactions(id) ON DELETE SET NULL,
  confirmed_at  timestamp with time zone,
  -- Why it went unconfirmed, in words a tenant can read.
  resolution_note text,

  created_at    timestamp with time zone NOT NULL DEFAULT now(),
  updated_at    timestamp with time zone NOT NULL DEFAULT now(),

  CONSTRAINT tenant_declared_deposits_amount_positive CHECK (amount > 0),
  CONSTRAINT tenant_declared_deposits_method_check
    CHECK (method = ANY (ARRAY['cash','check','money_order'])),
  CONSTRAINT tenant_declared_deposits_status_check
    CHECK (status = ANY (ARRAY['pending','confirmed','unconfirmed','withdrawn'])),
  -- A confirmation must name the evidence that produced it.
  CONSTRAINT tenant_declared_deposits_confirmed_has_txn
    CHECK (status <> 'confirmed' OR bank_transaction_id IS NOT NULL)
);

-- The matcher asks one question on every inbound bank row: which claims are
-- still open for this landlord, near this amount?
CREATE INDEX IF NOT EXISTS idx_tenant_declared_deposits_open
  ON tenant_declared_deposits (landlord_id, declared_date)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_tenant_declared_deposits_tenant
  ON tenant_declared_deposits (tenant_id, created_at DESC);
-- One bank deposit can only ever confirm one claim.
CREATE UNIQUE INDEX IF NOT EXISTS ux_tenant_declared_deposits_bank_txn
  ON tenant_declared_deposits (bank_transaction_id)
  WHERE bank_transaction_id IS NOT NULL;

DROP TRIGGER IF EXISTS set_updated_at_tenant_declared_deposits ON tenant_declared_deposits;
CREATE TRIGGER set_updated_at_tenant_declared_deposits
  BEFORE UPDATE ON tenant_declared_deposits
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE tenant_declared_deposits IS
  'S624: a tenant''s claim that they deposited rent at the bank. Changes nothing until a bank transaction confirms it — see the migration header for why that is the anti-fraud design.';
