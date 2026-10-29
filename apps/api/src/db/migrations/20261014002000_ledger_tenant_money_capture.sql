-- 10/12 (Nic, ledger P4) — TENANT MONEY POSTS ITSELF: THE SOURCES AND KINDS ITS
-- PROJECTORS NEED, AND THE TWO WORK-TRADE FACTS THEY READ
--
-- Phase P4 of the automatic ledger (gam-ledger-design-2026-10-12 §6 A-E, J)
-- posts every tenant charge, receipt, credit, deposit and reversal from the
-- money records (services/ledgerProjectors/tenant*.ts). Three small things the
-- engine's lists did not have yet:
--
--   1. A source type 'home_installment' (design A7b): a home-sale installment
--      the landlord was paid OUTSIDE GAM (home_sale_installments.
--      settled_off_platform_at, no payments row). Each posts on its own billing
--      month, so it cannot ride the contract's one posting; the capture on
--      home_sale_installments now also names the installment itself.
--   2. Two posting kinds:
--        'paid_from_deposit'  a bill the security deposit paid at move-out
--                             (payments.status 'paid_via_deposit'): the deposit
--                             owed back goes down, the bill is paid — its own
--                             day, beside the bill's charge posting;
--        'cancellation'       a home sale taken back, on the day it was
--                             cancelled, beside the sale itself.
--   3. payments.work_trade_credit and work_trade_settlement_id (added by
--      20261013235140) are now capture columns: a bill posts at amount +
--      work_trade_credit with the hours beside it (design A1, C5), and a
--      shortfall row billed with no bill is space rent (A9). Until now a
--      change of either alone would not have marked the payment.
--
-- The CHECKs are WIDENED, never narrowed, by adding to whatever values the
-- constraint holds right now (another phase may have widened it first), so
-- the order the ledger phases ship in never drops a value. Values match
-- LEDGER_SOURCE_TYPES and LEDGER_POSTING_KINDS in packages/shared/src/
-- booksLedger.ts (services/ledgerCoverage.test.ts holds them together).
--
-- Re-installing a capture replaces its three trigger bodies only
-- (ledger_install_capture, 20261013200600): no table lock beyond a write's.
--
-- The ledger is DARK in production until the integrate step registers the P4
-- projectors. Expand-only; safe to apply before the code ships.
-- No backfill needed (a projector phase's first rebuild reads the rows).
-- Safe drop: re-install the two captures with their 20261013200600 lists; the
-- widened CHECK values are unused until P4 posts.

SET LOCAL lock_timeout = '10s';

-- ── 1 + 2. Widen the two CHECKs (current values ∪ the new ones) ─────────────
DO $widen$
DECLARE
  cur  text[];
  want text[];
BEGIN
  SELECT array_agg(m[1] ORDER BY ord) INTO cur
    FROM pg_constraint c
    CROSS JOIN LATERAL regexp_matches(pg_get_constraintdef(c.oid), '''([^'']+)''', 'g') WITH ORDINALITY AS x(m, ord)
   WHERE c.conrelid = 'ledger_postings'::regclass AND c.conname = 'ledger_postings_source_type_check';
  IF cur IS NULL THEN
    RAISE EXCEPTION 'ledger_postings_source_type_check is missing';
  END IF;
  SELECT array_agg(v ORDER BY first_ord) INTO want FROM (
    SELECT v, min(ord) AS first_ord
      FROM unnest(cur || ARRAY['home_installment']) WITH ORDINALITY AS u(v, ord)
     GROUP BY v) s;
  IF want <> cur THEN
    ALTER TABLE ledger_postings DROP CONSTRAINT ledger_postings_source_type_check;
    EXECUTE format('ALTER TABLE ledger_postings ADD CONSTRAINT ledger_postings_source_type_check CHECK (source_type IN (%s))',
                   (SELECT string_agg(quote_literal(v), ', ' ORDER BY o) FROM unnest(want) WITH ORDINALITY AS w(v, o)));
  END IF;

  SELECT array_agg(m[1] ORDER BY ord) INTO cur
    FROM pg_constraint c
    CROSS JOIN LATERAL regexp_matches(pg_get_constraintdef(c.oid), '''([^'']+)''', 'g') WITH ORDINALITY AS x(m, ord)
   WHERE c.conrelid = 'ledger_postings'::regclass AND c.conname = 'ledger_postings_kind_check';
  IF cur IS NULL THEN
    RAISE EXCEPTION 'ledger_postings_kind_check is missing';
  END IF;
  SELECT array_agg(v ORDER BY first_ord) INTO want FROM (
    SELECT v, min(ord) AS first_ord
      FROM unnest(cur || ARRAY['paid_from_deposit', 'cancellation']) WITH ORDINALITY AS u(v, ord)
     GROUP BY v) s;
  IF want <> cur THEN
    ALTER TABLE ledger_postings DROP CONSTRAINT ledger_postings_kind_check;
    EXECUTE format('ALTER TABLE ledger_postings ADD CONSTRAINT ledger_postings_kind_check CHECK (posting_kind IN (%s))',
                   (SELECT string_agg(quote_literal(v), ', ' ORDER BY o) FROM unnest(want) WITH ORDINALITY AS w(v, o)));
  END IF;
END $widen$;

-- ── 1. A home-sale installment paid outside GAM marks itself ────────────────
SELECT ledger_install_capture('home_sale_installments',
  ARRAY['contract_id', 'payment_id', 'billing_month', 'amount', 'principal_portion', 'interest_portion', 'settled_off_platform_at'],
  $k$SELECT v.* FROM (SELECT (SELECT c.landlord_id FROM home_sale_contracts c WHERE c.id = r.contract_id) AS owner) o
      CROSS JOIN LATERAL (VALUES ('payment'::text, r.payment_id::text, o.owner),
                                 ('home_sale', r.contract_id::text, o.owner),
                                 ('home_installment', r.id::text, o.owner),
                                 ('opening', o.owner::text, o.owner)) v$k$);

-- ── 3. The two work-trade facts mark the payment ────────────────────────────
SELECT ledger_install_capture('payments',
  ARRAY['landlord_id', 'unit_id', 'lease_id', 'tenant_id', 'type', 'amount', 'status', 'due_date', 'settled_at',
        'entry_description', 'lease_fee_id', 'invoice_id', 'reversal_id', 'revenue_owner', 'manual_method', 'voided_at',
        'home_sale_installment_id', 'flexpay_advance_id', 'is_remainder', 'sublease_markup_amount',
        'gam_supersedence_amount', 'payment_channel', 'issued_credit_amount', 'deposit_collected_by',
        'work_trade_credit', 'work_trade_settlement_id'],
  $k$SELECT 'payment'::text, r.id::text, r.landlord_id
      UNION ALL SELECT 'remittance', ra.remittance_id::text, r.landlord_id FROM remittance_applications ra WHERE ra.payment_id = r.id$k$);

-- Everything installed still matches its table.
SELECT ledger_check_capture();
