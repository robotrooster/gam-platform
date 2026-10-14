-- 10/14 (Nic, I1-I2) — GAM BOOKS LEDGER: A STAY'S CHANGE RE-POSTS WHAT TAKES ITS MONEY BACK
--
-- Nic's bookkeeper (10/14): "RV stays that are long-term versus the
-- short-term taxable ones ... we need everything to be as itemized as
-- possible". I2: under 30 nights is short-term; 30+ nights or a lease is
-- long-term. A stay's money books to the line its stay is (services/
-- ledgerProjectors/incomeLines loadStay: the booking's nights, its terms,
-- its space), and so does everything that takes that money back, so each
-- line nets alike:
--
--   refund_part     an early check-out's refund (stay_refund_parts.booking_id)
--   pos_refund      a register refund of a sale that paid toward the stay
--                   (stay_payments.pos_transaction_id)
--   held_item       a chargeback on the stay's booking-site deposit, or on a
--                   register sale that paid toward it (connect_disputes by its
--                   card charge)
--   prepaid_credit  the reservation deposit's leftover moved to credit on the
--                   lease the stay became (leases.source_booking_id)
--
-- Design §7: a change to any fact a posting reads marks it for posting
-- within the minute. Until now a booking's change (its dates, its terms, its
-- space) marked only the booking's own postings, so a stay stretched past 30
-- nights after a refund moved its income to RV long-term rent while the
-- refund stayed on the short-term line until the nightly check found the
-- drift. The booking's capture now also marks those four.
--
-- The captured columns are unchanged (LEDGER_CAPTURE_COLUMNS.unit_bookings in
-- packages/shared/src/booksLedger.ts; services/ledgerCoverage.test.ts holds
-- them equal); only the sources a change marks grow. Re-installing a capture
-- replaces its three trigger bodies only (ledger_install_capture,
-- 20261013200600): no table lock beyond a write's.
-- Expand-only; safe to apply before the code ships (a marked source the old
-- code re-posts comes out as it was). No backfill needed: the deploy's
-- from-scratch rebuild reads every row.
-- Safe drop: re-install the unit_bookings capture with its earlier keys
-- (20261014150200).

SET LOCAL lock_timeout = '10s';

SELECT ledger_install_capture('unit_bookings',
  ARRAY['landlord_id', 'unit_id', 'tenant_id', 'status', 'check_in', 'check_out', 'booked_check_out', 'nights',
        'total_amount', 'nightly_rate', 'deposit_amount', 'deposit_paid_at', 'balance_paid_at', 'cancelled_at',
        'pos_transaction_id', 'lease_type', 'stay_terms'],
  $k$SELECT v.* FROM (VALUES ('booking'::text, r.id::text, r.landlord_id),
                           ('booking', r.id::text || '|end', r.landlord_id)) v
     UNION ALL
     SELECT 'booking', r.id::text || '|' || m.k::text, r.landlord_id
       FROM generate_series(1, ledger_booking_stay_month_count(r.check_in, r.check_out, r.booked_check_out)) AS m(k)
     UNION ALL
     SELECT 'refund_part', rp.id::text, rp.landlord_id FROM stay_refund_parts rp WHERE rp.booking_id = r.id
     UNION ALL
     SELECT 'pos_refund', pr.id::text, pr.landlord_id FROM pos_refunds pr
      WHERE pr.transaction_id IN (SELECT sp.pos_transaction_id FROM stay_payments sp
                                   WHERE sp.booking_id = r.id AND sp.pos_transaction_id IS NOT NULL)
     UNION ALL
     SELECT 'held_item', h.id::text, h.landlord_id FROM held_payout_items h
       JOIN connect_disputes cd ON cd.stripe_dispute_id = split_part(h.source_id, ':', 1)
      WHERE h.source_type = 'dispute'
        AND (cd.stripe_payment_intent_id = r.stripe_payment_intent_id
             OR cd.stripe_payment_intent_id IN (SELECT t.stripe_payment_intent_id FROM stay_payments sp
                                                  JOIN pos_transactions t ON t.id = sp.pos_transaction_id
                                                 WHERE sp.booking_id = r.id))
     UNION ALL
     SELECT 'prepaid_credit', pc.id::text, l.landlord_id FROM lease_prepaid_credits pc
       JOIN leases l ON l.id = COALESCE(pc.received_lease_id, pc.lease_id)
      WHERE l.source_booking_id = r.id AND pc.funded_by = 'reclassified'$k$);

-- The body still matches its table (the same check the DDL guard runs).
SELECT ledger_check_capture();
