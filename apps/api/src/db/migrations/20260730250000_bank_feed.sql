-- Bank feed (S570, Nic) — Stripe Financial Connections transactions feed.
--
-- WHY: GAM already knows the money that flows THROUGH it (rent in via `payments`,
-- payouts out via `disbursements`). It cannot see money a landlord spends from
-- THEIR OWN operating bank — a $1k Home Depot charge, an insurance premium, a
-- plumber paid off-platform. Those never touch GAM, so the P&L is blind to them.
--
-- This wires a read-only bank feed (Stripe Financial Connections, `transactions`
-- scope only — 30¢/account/month flat; balances/owners NOT requested, so $0
-- extra). The landlord already links a bank to Stripe for payouts, so this is the
-- same vendor, and the FC account-holder is a plain Stripe Customer we create for
-- the landlord (separate from their Connect account).
--
-- Flow: link → sync transactions (idempotent on external_id) → AUTO-MATCH inbound
-- deposits to the GAM disbursements that produced them (hidden from review) →
-- surface the rest for a 2-click categorize. Categorizing an OUTFLOW writes a
-- `landlord_expenses` row (reusing the unit / common / allocate-per-unit model),
-- which flows into the shared landlord P&L automatically. The landlord ALWAYS
-- confirms and ALWAYS picks scope (a unit, or property-general split across
-- units); auto-suggest only PRE-FILLS from remembered per-landlord merchant
-- choices. Provider-agnostic (`provider`): Stripe FC today, CSV import later.
--
-- Retention: soft states only (status columns), never hard delete.

-- ── FC account-holder customer on the landlord (reused across connections) ──
ALTER TABLE landlords ADD COLUMN IF NOT EXISTS stripe_fc_customer_id text;

-- ── Linked bank accounts ────────────────────────────────────────────────────
CREATE TABLE bank_connections (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  landlord_id          uuid NOT NULL REFERENCES landlords(id),
  provider             text NOT NULL DEFAULT 'stripe_fc' CHECK (provider IN ('stripe_fc','csv')),
  stripe_fc_account_id text,           -- fca_* (Stripe FC account); NULL for csv
  stripe_fc_session_id text,           -- fcsess_* the account was linked through
  institution_name     text,
  account_last4        text,
  account_type         text,           -- 'checking' | 'savings' | 'other' (as Stripe reports)
  display_name         text,           -- landlord-editable label ("Operating checking")
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disconnected','error')),
  last_synced_at       timestamptz,
  last_sync_error      text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
-- One GAM connection per Stripe FC account.
CREATE UNIQUE INDEX idx_bank_connections_fc_account ON bank_connections(stripe_fc_account_id)
  WHERE stripe_fc_account_id IS NOT NULL;
CREATE INDEX idx_bank_connections_landlord ON bank_connections(landlord_id) WHERE status = 'active';

COMMENT ON TABLE bank_connections IS
  'S570: a landlord''s linked operating bank (Stripe FC transactions scope, or CSV). Source of bank_transactions.';

-- ── Normalized bank transactions ────────────────────────────────────────────
CREATE TABLE bank_transactions (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_connection_id      uuid NOT NULL REFERENCES bank_connections(id),
  landlord_id             uuid NOT NULL REFERENCES landlords(id),
  external_id             text NOT NULL,      -- fctxn_* (Stripe) or a CSV row hash — idempotency key
  posted_date             date NOT NULL,
  amount                  numeric(12,2) NOT NULL,  -- SIGNED: negative = money out (expense candidate)
  currency                text NOT NULL DEFAULT 'usd',
  description             text,               -- raw bank memo
  normalized_merchant     text,              -- cleaned key used to match merchant rules
  status                  text NOT NULL DEFAULT 'needs_review'
                            CHECK (status IN ('needs_review','matched','categorized','ignored')),
  -- When auto-matched to GAM-known money (hidden from the review queue):
  matched_payment_id      uuid REFERENCES payments(id),
  matched_disbursement_id uuid REFERENCES disbursements(id),
  -- When categorized into an expense:
  expense_id              uuid REFERENCES landlord_expenses(id),
  categorized_at          timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
-- Idempotent sync: re-pulling never duplicates a transaction on a connection.
CREATE UNIQUE INDEX idx_bank_transactions_external ON bank_transactions(bank_connection_id, external_id);
CREATE INDEX idx_bank_transactions_queue ON bank_transactions(landlord_id, status, posted_date DESC);
CREATE INDEX idx_bank_transactions_connection ON bank_transactions(bank_connection_id, posted_date DESC);

COMMENT ON TABLE bank_transactions IS
  'S570: normalized bank feed rows. needs_review→landlord categorizes; matched=GAM-known money (auto, hidden); categorized→landlord_expenses; ignored=dismissed. Idempotent on (connection, external_id).';

-- ── Per-landlord merchant memory (improves auto-suggestions over time) ───────
-- When a landlord categorizes a merchant, remember the choice so the next charge
-- from the same merchant pre-fills category + last-used scope. The landlord still
-- confirms every time; this only makes the suggestion smarter.
CREATE TABLE landlord_merchant_rules (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  landlord_id         uuid NOT NULL REFERENCES landlords(id),
  normalized_merchant text NOT NULL,
  category            text NOT NULL,
  -- Remembered scope (a soft default; landlord re-confirms scope each time):
  scope_kind          text NOT NULL CHECK (scope_kind IN ('unit','property_common','property_allocate')),
  property_id         uuid REFERENCES properties(id),
  unit_id             uuid REFERENCES units(id),
  hit_count           integer NOT NULL DEFAULT 1,
  last_used_at        timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_merchant_rules_landlord_merchant
  ON landlord_merchant_rules(landlord_id, normalized_merchant);

COMMENT ON TABLE landlord_merchant_rules IS
  'S570: per-landlord memory of how a merchant was last categorized (category + scope). Pre-fills the bank-feed suggestion; never auto-books — landlord confirms.';
