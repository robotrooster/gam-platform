-- 10/13 — A DISPUTE GAM WINS ON ITS OWN FEE PULL UNDOES ITSELF; A DISPUTE FEE
-- STRIPE NEVER STATES IS BILLED AT $15 AND CORRECTED WHEN IT DOES
--
-- Nic, 10/13 (afternoon): "Won GAM pull dispute: AUTOMATIC (back to collected;
-- anything collected twice credited back). Dispute fee unknown → bill $15."
--
-- Builds on 20261015130100_gam_debit_disputed (a pull the landlord's bank
-- disputes: its fees owed again, its own $6 voided, what it cost GAM at Stripe
-- billed at cost). Code: services/landlordGamDebit applyWonGamDebitDispute,
-- billDisputedPullCost, rebillDisputeCost.
--
-- 1. THE WIN (dispute_won_*). When Stripe decides the dispute for GAM and puts
--    the money back, in one transaction, once (the webhook that carries the
--    win, or the nightly sweep when a later pull still settling holds one of
--    the charges):
--      - every charge the pull collected goes back to collected by what the
--        pull took for it (collected_amount up again; the pull's
--        landlord_gam_charge_collections rows count again — they were never
--        removed);
--      - the pull's own $6 cost line, voided 'bank_debit_failed' when the
--        dispute opened, is the price of a transfer that did collect after
--        all: it is un-voided and collected again (its void stays in
--        audit_row_changes), and the $6 taken back off GAM's book
--        (platform_revenue_ledger adjustment 'dispute_spread_reversal', −6) is
--        earned again: a +6 'banking_spread' row, reference_type
--        'gam_bank_debit_dispute_won', reference_id the pull;
--      - what a charge can no longer take (it was collected again since — by
--        a payout's netting or a later pull: collected twice — or it was
--        voided since: owed by nobody) is given back to the landlord on their
--        next payout: a held_payout_items line, source_type 'refund',
--        source_id 'gam_debit_dispute_won:<pull id>:<charge id>', positive;
--      - the dispute's cost charge (bank_debit_failed_cost, source
--        'gam_bank_debit_disputed') is voided, reason 'dispute_won'
--        (20261015180100). What was already collected on it is given back the
--        same way (source_id 'gam_charge_voided:<charge id>'). Only the part
--        of Stripe's dispute fee that Stripe kept with the win (fee − what it
--        gave back) is still the landlord's (Nic G1, GAM never absorbs a fee):
--        billed again when above zero (see 3);
--      - an admin is told.
--    A LATER PULL DISPUTED AFTER A VOID (10/13 review, "every dollar counted
--    once"). A charge voided with money collected on it (a dispute's cost
--    taken back by a win, or by a re-bill — see 3) had all of it given back
--    ('gam_charge_voided:<charge>'). When the landlord's bank then disputes a
--    pull that collected it, the bank returns that pull's part to them a
--    second time. The dispute never reopens a voided charge (owed by nobody;
--    not counted in dispute_reopened_amount); its collected_amount comes down
--    by that part, and the part is taken back from their next payout: a
--    held_payout_items line, source_type 'refund', source_id
--    'gam_charge_voided_taken_back:<disputed pull id>:<charge id>', NEGATIVE,
--    at the charge's property (services/landlordGamDebit handleGamDebitDispute,
--    gamChargeVoidedTakeBackSourceId). If GAM wins that dispute too, the
--    pull's collection stands again and the win gives it back again
--    ('gam_debit_dispute_won:<that pull>:<charge>', "voided since").
--    So, per charge, at every step:
--      Σ collections of pulls that are not disputed, or whose dispute was won
--      (disputed_at IS NULL OR dispute_won_at IS NOT NULL), and of payout
--      batches − Σ its 'gam_debit_dispute_won:…:<charge>' lines
--      = collected_amount;
--    and a voided charge's collected_amount is given back whole, net of what
--    was taken back:
--      Σ its 'gam_charge_voided:<charge>' line
--      + Σ its 'gam_charge_voided_taken_back:…:<charge>' lines (negative)
--      = collected_amount.
--    What a landlord owes GAM therefore reads, across every charge:
--      Σ live charges − Σ those collections
--      + Σ every give-back line of a charge (the two positive prefixes AND the
--        negative 'gam_charge_voided_taken_back:' lines)
--      = Σ live (amount − collected_amount).
--    The ledger side (taking back the pull's 'cancellation' posting, posting
--    the given-back lines) is the GAM Books ledger's; dispute_won_at is not a
--    ledger capture column yet (it is appended there, as 20261015140100
--    appended disputed_at).
--
-- 2. THE DISPUTE FEE (dispute_fee_*). Stripe's dispute fee is read from the
--    dispute (an event's balance transactions, else Stripe). When Stripe has
--    still not stated it FAILED_PULL_COST_UNREAD_DAYS (3) after the dispute,
--    the nightly sweep bills $15 — Stripe's usual dispute fee
--    (STRIPE_USUAL_DISPUTE_FEE_CENTS) — with the pull's own Stripe fee, and
--    marks it assumed. It keeps asking Stripe (for 60 days), and a webhook
--    that states the fee is read too: once Stripe states it, the bill is
--    corrected to it (see 3), never billed twice.
--      dispute_fee_amount      the dispute fee inside the bill: Stripe's word,
--                              or the $15 assumed
--      dispute_fee_assumed_at  when the $15 was billed because Stripe had not
--                              stated it (kept as history)
--      dispute_fee_stated_at   when Stripe's own word was recorded (at the
--                              first read, or correcting the $15). NULL with
--                              assumed_at set = still the $15, still asking.
--
-- 3. A RE-BILL. dispute_cost_amount / dispute_cost_charge_id now say the
--    CURRENT bill for what the dispute costs the landlord (they were the
--    first and only bill). A correction or a win that changes it voids the
--    current charge (reason 'dispute_cost_rebilled', or 'dispute_won'), gives
--    back what was collected on it, and bills the new amount as a new charge:
--    kind bank_debit_failed_cost, source_type 'gam_bank_debit_disputed' (so
--    the ledger reads it as the disputed pull's cost), source_id =
--    md5('<pull id>:<basis>')::uuid, basis one of 'stated' (Stripe's fee in
--    place of the $15), 'won_stated' / 'won_assumed' (what Stripe kept with a
--    win) — deterministic, so a retry can never bill one basis twice. The
--    first bill keeps source_id = the pull. A bill that comes to $0 leaves
--    dispute_cost_amount 0 and dispute_cost_charge_id NULL.
--
-- Expand-only: six nullable columns and two CHECKs every existing row meets
-- (all NULL; no pull has been disputed on production). No backfill needed.
-- Idempotent.

ALTER TABLE landlord_gam_debits ADD COLUMN IF NOT EXISTS dispute_fee_amount numeric(12,2);
ALTER TABLE landlord_gam_debits ADD COLUMN IF NOT EXISTS dispute_fee_assumed_at timestamptz;
ALTER TABLE landlord_gam_debits ADD COLUMN IF NOT EXISTS dispute_fee_stated_at timestamptz;
ALTER TABLE landlord_gam_debits ADD COLUMN IF NOT EXISTS dispute_won_at timestamptz;
ALTER TABLE landlord_gam_debits ADD COLUMN IF NOT EXISTS dispute_won_restored_amount numeric(12,2);
ALTER TABLE landlord_gam_debits ADD COLUMN IF NOT EXISTS dispute_won_given_back_amount numeric(12,2);

-- The dispute fee is part of a bill that was read; assumed or stated, it is there.
ALTER TABLE landlord_gam_debits DROP CONSTRAINT IF EXISTS landlord_gam_debits_dispute_fee_shape;
ALTER TABLE landlord_gam_debits ADD CONSTRAINT landlord_gam_debits_dispute_fee_shape
  CHECK ((dispute_fee_amount IS NULL OR (dispute_fee_amount >= 0 AND dispute_cost_read_at IS NOT NULL))
     AND (dispute_fee_assumed_at IS NULL OR dispute_fee_amount IS NOT NULL)
     AND (dispute_fee_stated_at IS NULL OR dispute_fee_amount IS NOT NULL));

-- Won together: when, and what it did. Only a pull whose dispute reopened it can be won back.
ALTER TABLE landlord_gam_debits DROP CONSTRAINT IF EXISTS landlord_gam_debits_dispute_won_shape;
ALTER TABLE landlord_gam_debits ADD CONSTRAINT landlord_gam_debits_dispute_won_shape
  CHECK ((dispute_won_at IS NULL OR disputed_at IS NOT NULL)
     AND ((dispute_won_at IS NULL) = (dispute_won_restored_amount IS NULL))
     AND ((dispute_won_at IS NULL) = (dispute_won_given_back_amount IS NULL))
     AND (dispute_won_restored_amount IS NULL OR dispute_won_restored_amount >= 0)
     AND (dispute_won_given_back_amount IS NULL OR dispute_won_given_back_amount >= 0));

COMMENT ON COLUMN landlord_gam_debits.dispute_cost_amount IS
  '10/13 (Nic G1): what the dispute costs the landlord now, billed at cost — Stripe''s fee on the pull plus Stripe''s dispute fee; after a win (dispute_won_at), only the part of the dispute fee Stripe kept. A correction or a win re-bills it (migration 20261015180000). NULL = not read from Stripe yet (the nightly sweep asks again).';
COMMENT ON COLUMN landlord_gam_debits.dispute_cost_charge_id IS
  '10/13: the landlord_gam_charges row (kind bank_debit_failed_cost, source_type gam_bank_debit_disputed) that bills dispute_cost_amount now. A re-bill voids the one before it (reason dispute_cost_rebilled or dispute_won) and points here at the new one (source_id md5(''<pull id>:<basis>'')::uuid). NULL when it costs nothing.';
COMMENT ON COLUMN landlord_gam_debits.dispute_fee_amount IS
  '10/13 (Nic): Stripe''s dispute fee inside dispute_cost_amount — Stripe''s own word, or $15 (Stripe''s usual fee) when Stripe had not stated it three days after the dispute (dispute_fee_assumed_at). NULL = not read yet.';
COMMENT ON COLUMN landlord_gam_debits.dispute_fee_assumed_at IS
  '10/13 (Nic: "Dispute fee unknown → bill $15"): when $15 was billed as the dispute fee because Stripe had not stated it. Kept as history; dispute_fee_stated_at says when Stripe''s word replaced it.';
COMMENT ON COLUMN landlord_gam_debits.dispute_fee_stated_at IS
  '10/13: when Stripe''s own word on its dispute fee was recorded — at the first read, or correcting the $15 assumed (the bill re-billed to it, never billed twice). NULL with dispute_fee_assumed_at set: still the $15, and the sweep keeps asking Stripe.';
COMMENT ON COLUMN landlord_gam_debits.dispute_won_at IS
  '10/13 (Nic: "Won GAM pull dispute: AUTOMATIC (back to collected; anything collected twice credited back)"): when Stripe''s win for GAM was applied — every charge the pull collected back to collected, its own $6 cost line un-voided and collected (+$6 earned again on GAM''s book: banking_spread, reference_type gam_bank_debit_dispute_won), what was collected twice given back on held_payout_items lines (refund, gam_debit_dispute_won:<pull>:<charge>), the dispute''s cost charge voided (dispute_won; collected part given back, gam_charge_voided:<charge>). The pull''s ''cancellation'' posting is taken back by the ledger. NULL = not won (or not applied yet).';
COMMENT ON COLUMN landlord_gam_debits.dispute_won_restored_amount IS
  '10/13: what the win put back to collected across the pull''s charges, its own $6 cost line included. Set with dispute_won_at.';
COMMENT ON COLUMN landlord_gam_debits.dispute_won_given_back_amount IS
  '10/13: what the win gave back to the landlord on their next payout (held_payout_items, source_type refund): charges collected again since the dispute (collected twice), what the pull had paid on charges voided since (gam_debit_dispute_won:<pull>:<charge> both), and what was collected on the voided dispute cost charge (gam_charge_voided:<charge>). Set with dispute_won_at.';
