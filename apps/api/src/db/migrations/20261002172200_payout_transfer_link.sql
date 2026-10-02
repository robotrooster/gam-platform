-- S655 (Nic): "$2,638.11 from GAM" — which payments was that?
--
-- A payout to a landlord's bank sweeps their Stripe balance, which is filled by
-- GAM's platform→Connect transfers (platform_transfer_intents). Nothing recorded
-- which transfers a payout carried, and Stripe cannot say: GAM's Connect
-- accounts use manual payouts, and Stripe only itemizes automatic ones. GAM's
-- own data can rebuild it exactly, so the link is recorded at the moment GAM
-- fires a payout (jobs/autoPayouts.ts) or files one the landlord made in Stripe
-- (services/connectPayoutSync.ts).
--
-- Additive (expand). The four existing transfers are linked by
-- scripts/oct2_payout_transfer_backfill.ts (dry run by default), not here.
ALTER TABLE platform_transfer_intents
  ADD COLUMN IF NOT EXISTS disbursement_id uuid REFERENCES disbursements(id);

CREATE INDEX IF NOT EXISTS idx_platform_transfer_intents_disbursement
  ON platform_transfer_intents (disbursement_id) WHERE disbursement_id IS NOT NULL;

-- The lookup a payout makes: this account's transfers not yet in any payout.
CREATE INDEX IF NOT EXISTS idx_platform_transfer_intents_unpaid_out
  ON platform_transfer_intents (destination_connect_account_id, transferred_at)
  WHERE disbursement_id IS NULL AND status = 'transferred';

COMMENT ON COLUMN platform_transfer_intents.disbursement_id IS 'S655: the payout (disbursements row) that carried this transfer from the landlord''s Stripe balance to their bank. NULL until paid out.';
