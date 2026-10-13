-- 10/12 (Nic) — GAM BOOKS LEDGER: OPENING BALANCES A COMPANY ENTERS BY HAND
--
-- A company's books start on its books start date (landlords.books_start_date).
-- What happened before that date opens as one posting per company (the
-- "opening" source, design J1). Most of it is worked out from GAM's own
-- records; a few balances GAM has no record of, and the company enters them
-- once in an "Opening balances" step (gam-ledger-design-2026-10-12 §4, §15
-- step 5):
--
--   bank             a linked bank account's balance on the start date
--                    (bank_connection_id)
--   deposit_held     a deposit a tenant paid the landlord before GAM, that the
--                    landlord still holds (lease_id, tenant_id, property_id).
--                    Nic 10/12 (L14): the company decides whether to enter them.
--   paid_ahead_held  money a tenant paid ahead to the landlord before GAM
--   other            anything else the opening needs
--
-- Kept forever: an item entered by mistake is voided (voided_at, voided_by,
-- void_reason), never removed. Every change marks the company's opening
-- posting for re-projection (the ledger outbox capture, 20261013200600).
-- Journaled like every money table (audit_row_change; CLAUDE.md 10/12, the
-- change journal is never pruned). Values match LEDGER_OPENING_ITEM_KINDS in
-- packages/shared/src/booksLedger.ts.
--
-- The ledger is DARK: no screen writes these yet. Expand-only.
-- No backfill needed (new table).
-- Safe drop: DROP TABLE books_opening_items.

SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS books_opening_items (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  landlord_id         uuid REFERENCES landlords(id),
  business_id         uuid REFERENCES businesses(id),
  kind                text NOT NULL,
  lease_id            uuid,
  tenant_id           uuid,
  property_id         uuid,
  bank_connection_id  uuid REFERENCES bank_connections(id),
  amount              numeric(12,2) NOT NULL,
  as_of               date NOT NULL,
  memo                text,
  entered_by          uuid REFERENCES users(id),
  entered_at          timestamptz NOT NULL DEFAULT now(),
  voided_at           timestamptz,
  voided_by           uuid REFERENCES users(id),
  void_reason         text,
  CONSTRAINT books_opening_items_one_owner CHECK (num_nonnulls(landlord_id, business_id) = 1),
  CONSTRAINT books_opening_items_kind_check CHECK (kind IN ('bank', 'deposit_held', 'paid_ahead_held', 'other')),
  CONSTRAINT books_opening_items_bank_names_bank CHECK (kind <> 'bank' OR bank_connection_id IS NOT NULL),
  CONSTRAINT books_opening_items_held_names_lease CHECK (kind NOT IN ('deposit_held', 'paid_ahead_held') OR lease_id IS NOT NULL),
  CONSTRAINT books_opening_items_void_stamped CHECK ((voided_at IS NULL) = (voided_by IS NULL))
);

CREATE INDEX IF NOT EXISTS books_opening_items_landlord ON books_opening_items (landlord_id) WHERE landlord_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS books_opening_items_business ON books_opening_items (business_id) WHERE business_id IS NOT NULL;

COMMENT ON TABLE books_opening_items IS
  '10/12 (Nic, ledger J1): opening balances a company enters by hand (bank balances, pre-GAM deposits and paid-ahead money). Voided, never removed.';

DROP TRIGGER IF EXISTS audit_books_opening_items ON books_opening_items;
CREATE TRIGGER audit_books_opening_items
  AFTER DELETE OR UPDATE ON books_opening_items
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
