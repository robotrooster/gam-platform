-- 10/12 (Nic) — GAM BOOKS LEDGER: LINKING A TRANSFER TO A PAYOUT RE-POSTS THE PAYOUT
--
-- The ledger posts a payout to the landlord's bank (source 'disbursement',
-- services/ledgerProjectors/payoutDisbursement, design G3) at the properties
-- of the transfers it carried: platform_transfer_intents.disbursement_id. That
-- link is written AFTER the payout row (services/payoutCut
-- stampPayoutTransfers, best-effort, and again by the restamp sweep), and is
-- cleared when a payout fails (connectPayoutSync) — and until now a change to
-- it marked only the transfer itself ('transfer_intent'). So a payout could
-- post before its transfers were linked and keep a company-level split until
-- the nightly check found the drift.
--
-- This re-installs the capture of platform_transfer_intents with one more key:
-- the payout it is linked to, from the old row and the new row alike (linking,
-- re-linking and unlinking all re-post the payout). Same columns as before
-- (LEDGER_CAPTURE_COLUMNS.platform_transfer_intents in packages/shared/src/
-- booksLedger.ts; services/ledgerCoverage.test.ts holds them equal).
-- Re-installing replaces the capture bodies only (ledger_install_capture: no
-- table lock beyond a write's); the triggers already exist.
-- Expand-only. No backfill needed (the ledger is dark).
-- Safe drop: re-run ledger_install_capture for platform_transfer_intents with
-- its 20261013200600 keys.

SET LOCAL lock_timeout = '2s';

SELECT ledger_install_capture('platform_transfer_intents',
  ARRAY['landlord_id', 'business_id', 'destination_connect_account_id', 'amount', 'gross_owed', 'netted_amount',
        'status', 'transferred_at', 'purpose', 'deposit_return_id', 'flexcharge_statement_id', 'disbursement_id'],
  $k$SELECT v.* FROM (VALUES ('transfer_intent'::text, r.id::text, COALESCE(r.landlord_id, r.business_id)),
                           ('disbursement', r.disbursement_id::text, COALESCE(r.landlord_id, r.business_id))) v$k$);

SELECT ledger_check_capture();
