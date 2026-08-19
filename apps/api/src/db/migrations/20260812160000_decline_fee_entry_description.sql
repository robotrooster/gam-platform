-- Add 'DECLINEFEE' to the payments.entry_description catalog (S603, Nic).
--
-- WHY: a declined card attempt costs GAM real money that no one currently pays.
-- Stripe bills per AUTHORIZATION, not per successful payment — every decline burns
-- $0.26 (per-auth) + $0.02 (Radar) = $0.28 with zero revenue against it. The same
-- $0.28 is burned when a tenant saves or re-saves a card, which happens repeatedly
-- as cards are lost, stolen, and reissued.
--
-- Nic's call (S603): a FLAT $1.00 fee on every declined card attempt. The surplus
-- over the $0.28 decline cost (~$0.72) funds the card-save and re-save
-- authorizations, which makes keeping card-on-file self-supporting instead of a
-- standing leak. ACH is UNCHANGED — it keeps its own $4.00 return fee (RETURNFEE).
--
-- NOT the same thing as RETURNFEE. RETURNFEE covers a payment that SETTLED and was
-- later reversed (chargeback / ACH return). DECLINEFEE covers a payment that never
-- succeeded at all — the bank refused the authorization. Distinct events, distinct
-- costs, distinct tenant-facing wording, so they get distinct codes.
--
-- 'DECLINEFEE' is 10 chars — the NACHA entry-description field limit, so it fits
-- exactly. Mirrors PAYMENT_ENTRY_DESCRIPTIONS in packages/shared/src/index.ts.
--
-- No backfill needed (new code; no existing row can carry it).

ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_entry_description_check;

ALTER TABLE payments ADD CONSTRAINT payments_entry_description_check
  CHECK (entry_description = ANY (ARRAY[
    'RENT', 'SUBSCRIP', 'DEPOSIT', 'UTILITY', 'ONTIMEPAY', 'LATEFEE',
    'FLEXPAY', 'PROPANE', 'RETURNFEE', 'MANUALPAY', 'HOMEPMT', 'FCPAYDOWN',
    'DECLINEFEE'
  ]));
