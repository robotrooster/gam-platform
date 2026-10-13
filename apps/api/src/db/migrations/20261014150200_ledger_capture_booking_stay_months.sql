-- 10/12 (Nic) — GAM BOOKS LEDGER: A STAY IS EARNED WHEN THE GUEST ARRIVES, MONTH BY MONTH PAST 30 NIGHTS
--
-- Nic, 10/12 (L10): stays and booking deposits are income WHEN THE GUEST
-- ARRIVES — short stays on arrival, 30+ night stays month by month — and the
-- money is held as a guest deposit (2060) until then. The ledger's booking
-- projector (services/ledgerProjectors/bookingStay) posts that schedule:
--
--   'booking' <booking id>         the booking-site deposit (money in, its day)
--                                  and the first stay-month earned (arrival day)
--   'booking' <booking id>|<k>     the k-th further stay-month earned, on the day
--                                  it starts (arrival + k calendar months), for
--                                  a stay of 30+ nights sold
--   'booking' <booking id>|end     money for stay-months the guest never reached
--                                  (an early check-out, a cancellation, a
--                                  no-show), earned the day the stay ended
--
-- The engine posts one dated posting per source and posting kind, so each
-- stay-month is its own source id. This re-installs the capture of the two
-- tables the schedule is read from so that a change marks EVERY one of those
-- ids — from the old row and the new row alike (a stay shortened from three
-- months to one marks the two months it no longer has, so they are taken
-- back):
--   unit_bookings  its dates, status and whether its lease bills the rest
--                  (stay_terms, newly captured: a stay whose lease bills the
--                  rest is earned whole on arrival, never month by month)
--   stay_payments  each payment toward the stay (the money the schedule earns)
-- Over-marking is harmless: an id the schedule does not have posts nothing.
-- (The keys join with a comma, never "JOIN LATERAL": the DDL guard reads every
-- name after FROM / JOIN in a capture body as a table it must watch.)
--
-- ledger_booking_stay_month_count(check_in, check_out, booked_check_out): how
-- many stay-months start after the first, inside the nights SOLD (the later of
-- check_out and booked_check_out) — arrival + k months, k ≥ 1, before the sold
-- check-out, at most 600. The projector computes the same starts the same way
-- ((check_in + k months)::date, PostgreSQL month arithmetic).
--
-- Columns listed match LEDGER_CAPTURE_COLUMNS in packages/shared/src/
-- booksLedger.ts (services/ledgerCoverage.test.ts holds them equal).
-- Re-installing replaces the capture bodies only (no table lock beyond a
-- write's, ledger_install_capture); the triggers already exist.
-- Expand-only. No backfill needed (the ledger is dark; the projector phase's
-- first rebuild reads the rows themselves).
-- Safe drop: re-run ledger_install_capture for unit_bookings and stay_payments
-- with their 20261013200600 lists and keys, then DROP FUNCTION
-- ledger_booking_stay_month_count(date, date, date).

SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION ledger_booking_stay_month_count(p_check_in date, p_check_out date, p_booked date) RETURNS integer
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_check_in IS NULL OR GREATEST(p_check_out, COALESCE(p_booked, p_check_out)) IS NULL THEN 0
    WHEN GREATEST(p_check_out, COALESCE(p_booked, p_check_out)) <= p_check_in THEN 0
    ELSE (SELECT count(*)::integer
            FROM generate_series(1, LEAST(600, (GREATEST(p_check_out, COALESCE(p_booked, p_check_out)) - p_check_in) / 28 + 1)) AS m(k)
           WHERE (p_check_in + make_interval(months => m.k))::date < GREATEST(p_check_out, COALESCE(p_booked, p_check_out)))
  END
$$;

COMMENT ON FUNCTION ledger_booking_stay_month_count(date, date, date) IS
  '10/12 (Nic, L10): stay-months that start after the first inside the nights sold (arrival + k months before the later of check_out / booked_check_out); the booking capture marks one ledger source per stay-month.';

SELECT ledger_install_capture('unit_bookings',
  ARRAY['landlord_id', 'unit_id', 'tenant_id', 'status', 'check_in', 'check_out', 'booked_check_out', 'nights',
        'total_amount', 'nightly_rate', 'deposit_amount', 'deposit_paid_at', 'balance_paid_at', 'cancelled_at',
        'pos_transaction_id', 'lease_type', 'stay_terms'],
  $k$SELECT v.* FROM (VALUES ('booking'::text, r.id::text, r.landlord_id),
                           ('booking', r.id::text || '|end', r.landlord_id)) v
     UNION ALL
     SELECT 'booking', r.id::text || '|' || m.k::text, r.landlord_id
       FROM generate_series(1, ledger_booking_stay_month_count(r.check_in, r.check_out, r.booked_check_out)) AS m(k)$k$);

SELECT ledger_install_capture('stay_payments',
  ARRAY['booking_id', 'landlord_id', 'kind', 'pos_transaction_id', 'method', 'toward_stay', 'card_fee',
        'landlord_card_fee', 'lodging_tax_amount', 'paid_at'],
  $k$SELECT v.* FROM (VALUES ('booking'::text, r.booking_id::text, r.landlord_id),
                           ('booking', r.booking_id::text || '|end', r.landlord_id)) v
     UNION ALL
     SELECT 'booking', b.id::text || '|' || m.k::text, b.landlord_id
       FROM unit_bookings b, generate_series(1, ledger_booking_stay_month_count(b.check_in, b.check_out, b.booked_check_out)) AS m(k)
      WHERE b.id = r.booking_id$k$);

-- Both bodies still match their tables (the same check the DDL guard runs).
SELECT ledger_check_capture();
