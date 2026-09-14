-- Money-flow audit (S639) — READ-ONLY. Run on the prod Mac:
--   psql -d gam -f scripts/money-flow-audit.sql
--
-- Context: under the S560 platform-holds model, tenant rent lands on GAM's
-- Stripe platform balance on purpose and batches out via jobs/autoPayouts.ts
-- (50%/90% rent-roll triggers + late-month sweep, or the weekly Tuesday batch).
-- This script answers "is anything actually stuck?" — pair it with the Stripe
-- dashboard checks in GCP_MIGRATION_PLAN.md (money-flow workstream).

\echo '=== 1. Held rent per landlord (what GAM owes, unfired) ==='
SELECT u.email,
       COUNT(DISTINCT p.id)      AS held_payments,
       SUM(ubl.amount)::numeric(12,2) AS owed_dollars,
       BOOL_AND(u.connect_payouts_enabled AND u.connect_details_submitted) AS connect_ready
  FROM payments p
  JOIN landlords l ON l.id = p.landlord_id
  JOIN users u     ON u.id = l.user_id
  JOIN user_balance_ledger ubl
    ON ubl.reference_id = p.id
   AND ubl.reference_type = 'payment'
   AND ubl.type = 'allocation_owner_share'
   AND ubl.stripe_transfer_id IS NULL
 WHERE p.platform_held = TRUE AND p.status = 'settled'
 GROUP BY u.email
 ORDER BY owed_dollars DESC;

\echo '=== 2. Landlords with held funds but Connect NOT ready (held indefinitely) ==='
SELECT DISTINCT u.email, u.stripe_connect_account_id,
       u.connect_payouts_enabled, u.connect_details_submitted,
       u.stripe_connect_status_synced_at
  FROM payments p
  JOIN landlords l ON l.id = p.landlord_id
  JOIN users u     ON u.id = l.user_id
  JOIN user_balance_ledger ubl
    ON ubl.reference_id = p.id AND ubl.type = 'allocation_owner_share'
   AND ubl.stripe_transfer_id IS NULL
 WHERE p.platform_held = TRUE AND p.status = 'settled'
   AND NOT (COALESCE(u.connect_payouts_enabled, FALSE)
        AND COALESCE(u.connect_details_submitted, FALSE));

\echo '=== 3. Payout triggers: what is claimed/scheduled/fired this cycle ==='
SELECT entity_kind, trigger_kind, units_paid, units_total,
       scheduled_for, fired_at, skipped_reason, defer_count, created_at
  FROM payout_triggers
 ORDER BY created_at DESC
 LIMIT 25;

\echo '=== 4. Stuck transfer intents (pending > 1 day = EXECUTE failed) ==='
SELECT id, landlord_id, amount, status, created_at, stripe_transfer_id
  FROM platform_transfer_intents
 WHERE status <> 'transferred'
 ORDER BY created_at DESC
 LIMIT 25;

\echo '=== 5. Recent disbursements (proves the batch fires at all) ==='
SELECT d.created_at, u.email, d.amount, d.status, d.trigger_type
  FROM disbursements d
  JOIN users u ON u.id = d.user_id
 ORDER BY d.created_at DESC
 LIMIT 25;

\echo '=== 6. Possibly-missed webhooks: processing > 24h (paymentReconcile also flags these) ==='
SELECT id, type, amount, status, created_at, stripe_payment_intent_id
  FROM payments
 WHERE status = 'processing' AND created_at < now() - interval '24 hours'
 ORDER BY created_at
 LIMIT 25;

\echo '=== 7. Card money on the platform with NO disbursement path (legacy routes/terminal.ts check) ==='
-- Legacy platform card_present PIs carry metadata.landlord_id but create no
-- payments row; they are invisible to this DB. Cross-check in the Stripe
-- dashboard instead: Payments -> filter card_present -> any PI WITHOUT
-- metadata.gam_purpose='pos_terminal' and WITHOUT a matching payments row here
-- came through the legacy route and has no disbursement path.
SELECT 'see comment above — dashboard check' AS note;
