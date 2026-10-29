-- 10/23 (Nic) — A HOME SALE CHANGES HANDS WITHOUT CHANGING ITS TERMS.
--
-- Live case: Country Acres MH 28. Susie McCoy is 38 payments into buying a
-- $24,000 home at $200/month and is leaving; the Bowmans' daughter is taking
-- over the spot AND the purchase.
--
--   "they're just going to take over the payments. They're going to take over
--    the space rent going forward... it's just a ownership transfer straight
--    across."
--
--   "because she's being added as a co-tenant, that financial responsibility
--    shouldn't be allowed to change... The park just wants what it was being
--    sold for in the first place."
--
-- So the CONTRACT does not move and does not change: same sale price, same
-- $200, same 82 payments left. What changes is WHO OWES THEM FROM A GIVEN
-- MONTH, and that is a new fact rather than an edit.
--
-- WHY NOT JUST UPDATE home_sale_contracts.tenant_id. Because it is a watched
-- ledger column (packages/shared/src/booksLedger.ts) with a change trigger on
-- the table: setting it re-projects the whole sale under a different person, so
-- every month Susie actually paid would read as the daughter's in the books.
-- The sale's history is the one thing a transfer must not touch. The contract
-- keeps the ORIGINAL buyer for good, and each handover is its own row here.
--
-- WHO OWES MONTH M = the latest assumption with effective_month <= M, and the
-- contract's own tenant_id when there is none. One rule, three readers (the
-- monthly invoice run, the standalone biller, the catch-up attach).
--
-- No backfill: every existing contract has no assumption, which resolves to its
-- own tenant_id — exactly today's behavior.

CREATE TABLE IF NOT EXISTS home_sale_assumptions (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  contract_id      UUID NOT NULL REFERENCES home_sale_contracts(id) ON DELETE CASCADE,
  landlord_id      UUID NOT NULL REFERENCES landlords(id),
  -- Who was paying, and who pays from `effective_month` on. Kept as tenants so
  -- the books can name both sides of the handover years later.
  from_tenant_id   UUID NOT NULL REFERENCES tenants(id),
  to_tenant_id     UUID NOT NULL REFERENCES tenants(id),
  -- The first month the new buyer owes. Always the 1st: an installment is a
  -- month, never a part of one.
  effective_month  DATE NOT NULL,
  -- The addendum the residents signed. A handover is paper, not a toggle.
  document_id      UUID REFERENCES lease_documents(id) ON DELETE SET NULL,
  -- What the landlord decided about anything still owed at the handover, which
  -- is a per-situation call and never a platform setting (10/22, Nic: "it needs
  -- to be an individual landlord decision"). 'leaver' = stays with the person
  -- going, flagged left-owing; 'space' = attaches to the space and goes forward
  -- with the new resident (the carry-forward lien).
  balance_goes_to  TEXT NOT NULL DEFAULT 'leaver'
                   CHECK (balance_goes_to IN ('leaver', 'space')),
  note             TEXT,
  recorded_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- A sale hands over once per month at most, and never to the person already
  -- paying it.
  CONSTRAINT home_sale_assumption_once_per_month UNIQUE (contract_id, effective_month),
  CONSTRAINT home_sale_assumption_changes_hands CHECK (from_tenant_id <> to_tenant_id),
  CONSTRAINT home_sale_assumption_whole_month CHECK (effective_month = date_trunc('month', effective_month)::date)
);

CREATE INDEX IF NOT EXISTS idx_home_sale_assumption_contract
  ON home_sale_assumptions (contract_id, effective_month DESC);

-- CLAUDE.md: every table that holds money gets the change journal in the
-- migration that creates it. This one holds no amount, but it decides WHOSE
-- money an installment is — which is the same thing from the ledger's side.
DROP TRIGGER IF EXISTS audit_home_sale_assumptions ON home_sale_assumptions;
CREATE TRIGGER audit_home_sale_assumptions
  AFTER UPDATE OR DELETE ON home_sale_assumptions
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

COMMENT ON TABLE home_sale_assumptions IS
  '10/23 (Nic): a home-installment sale taken over by the next resident "straight across" — same price, same payment. The contract keeps its original buyer (a watched ledger column); this says who owes it from which month.';
