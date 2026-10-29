-- 10/12 (Nic) — EVERY TRANSFER TO A LANDLORD'S STRIPE ACCOUNT HAS A RECORD,
-- WRITTEN BEFORE STRIPE IS ASKED (ledger design P0, M0b, §16.5).
--
-- The weekly payout batch has written a platform_transfer_intents row before
-- each transfer since S580, so a payout can list what it carried
-- (services/payoutComposition) and a stuck transfer is retried under the same
-- idempotency key. Two other transfers to a landlord's account never did:
--
--   - the landlord's share of a GAM-held deposit at move-out
--     (services/depositReturn fireLandlordDisbursementTransfer) — a failure
--     only raised an admin notice, and a success left no record at all, so
--     the payout that later swept it to the bank showed it as "not traced";
--   - the merchant share of a store charge account statement (FlexCharge:
--     services/flexCharge x2, services/flexpay, routes/webhooks) — gated, no
--     rows, but it must not be switched on without a record.
--
-- Both now write an intent first (status pending), confirm it on Stripe's
-- answer, and are linked to payouts like any other (stampPayoutTransfers).
--
--   purpose                  — @gam/shared PLATFORM_TRANSFER_PURPOSES; every
--                              existing row is the weekly batch ('payout')
--   deposit_return_id        — the move-out a 'deposit_settlement' pays
--   flexcharge_statement_id  — the statement a 'flexcharge_merchant' pays
--   stripe_idempotency_key   — the key the transfer was made under, so a
--                              retry of a direct transfer can never pay twice
--                              (the batch's key stays derived from its id)
--   stripe_request           — the description and metadata it was sent
--                              with: Stripe refuses a key reused with other
--                              parameters, so a retry must send the same ones
--
-- Expand-only; the defaults keep the batch writer (unchanged) valid.
-- No backfill: production 10/12 has 0 deposit returns and 0 FlexCharge
-- statements, so no direct transfer was ever made.

ALTER TABLE platform_transfer_intents
  ADD COLUMN IF NOT EXISTS purpose                 text NOT NULL DEFAULT 'payout',
  ADD COLUMN IF NOT EXISTS deposit_return_id       uuid REFERENCES deposit_returns(id),
  ADD COLUMN IF NOT EXISTS flexcharge_statement_id uuid REFERENCES flex_charge_statements(id),
  ADD COLUMN IF NOT EXISTS stripe_idempotency_key  text,
  ADD COLUMN IF NOT EXISTS stripe_request          jsonb;

ALTER TABLE platform_transfer_intents DROP CONSTRAINT IF EXISTS platform_transfer_intents_purpose_check;
ALTER TABLE platform_transfer_intents ADD CONSTRAINT platform_transfer_intents_purpose_check
  CHECK (purpose IN ('payout', 'deposit_settlement', 'flexcharge_merchant'));

-- What each kind of transfer pays, and nothing else. A direct transfer always
-- goes to a company (never a business) and always under its own key.
ALTER TABLE platform_transfer_intents DROP CONSTRAINT IF EXISTS platform_transfer_intents_purpose_refs;
ALTER TABLE platform_transfer_intents ADD CONSTRAINT platform_transfer_intents_purpose_refs CHECK (
  (purpose = 'payout'
     AND deposit_return_id IS NULL AND flexcharge_statement_id IS NULL)
  OR (purpose = 'deposit_settlement'
     AND deposit_return_id IS NOT NULL AND flexcharge_statement_id IS NULL
     AND landlord_id IS NOT NULL AND stripe_idempotency_key IS NOT NULL AND stripe_request IS NOT NULL)
  OR (purpose = 'flexcharge_merchant'
     AND flexcharge_statement_id IS NOT NULL AND deposit_return_id IS NULL
     AND landlord_id IS NOT NULL AND stripe_idempotency_key IS NOT NULL AND stripe_request IS NOT NULL));

-- One record per Stripe request: the writer inserts ON CONFLICT on this, so a
-- second call for the same transfer finds the first one's record.
CREATE UNIQUE INDEX IF NOT EXISTS platform_transfer_intents_idempotency_key
  ON platform_transfer_intents (stripe_idempotency_key) WHERE stripe_idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS platform_transfer_intents_deposit_return
  ON platform_transfer_intents (deposit_return_id) WHERE deposit_return_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS platform_transfer_intents_flexcharge_statement
  ON platform_transfer_intents (flexcharge_statement_id) WHERE flexcharge_statement_id IS NOT NULL;

COMMENT ON COLUMN platform_transfer_intents.purpose IS
  '10/12 (ledger P0): payout = the weekly batch; deposit_settlement = a move-out''s GAM-held deposit share (deposit_return_id); flexcharge_merchant = a store charge account statement''s merchant share (flexcharge_statement_id). Every transfer to a landlord''s Stripe account is written here before Stripe is called.';
COMMENT ON COLUMN platform_transfer_intents.stripe_idempotency_key IS
  '10/12: the Stripe idempotency key a direct transfer was made under (NULL for the weekly batch, whose key is derived from its id). A retry reuses it, so it can never pay twice.';
