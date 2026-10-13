-- 10/12 (Nic) — keep everything: a charge nobody owes is VOIDED, not deleted.
--
-- The nine places that DELETED an unpaid charge row when it stopped being owed
-- (a lease voided before the tenant signed, a new lease that will never start,
-- rent past a shortened stay's new end, a reservation's fee, a voided home
-- sale's payments) now mark it with the recorded void status decisions #48.5
-- gave payments — status 'voided', voided_at, void_reason — and keep it
-- (services/chargeVoids; design gam-ledger-design-2026-10-12 §P2). A voided row
-- now stays where a deleted one used to vanish from, and two database objects
-- still counted it as live:
--
-- 1. ux_payments_unit_rent_due_date_active — one live rent row per space and
--    due date. It left out only 'failed' and 'returned' rows, so a VOIDED rent
--    row kept the slot. A lease voided before the tenant signed and then sent
--    again could not bill its first month (the new rent row collided with the
--    voided one); a new lease that never started blocked the next tenant's
--    rent for the same space and date; a stay shortened and lengthened again
--    could not bill back the month it had given up. A voided row is owed by
--    nobody and paid by nothing, so it leaves the slot as a failed or returned
--    row does. The index only gets less strict — every row that passes today
--    still passes. (The two places that mirror it in code — routes/payments
--    initiate-rent-collection and services/paymentReversal's second-reopen
--    check — leave 'voided' out the same way.)
--
-- 2. fn_invoice_status_rollup_single — a bill's status from its lines. It
--    counted every line, so a bill whose rent was paid and that also carried a
--    voided line read 'partial' for good, never 'settled'. A voided line is
--    now left out of both counts, exactly as a deleted one was: a bill whose
--    lines are all voided reads 'pending', as a bill with no lines always has
--    (callers that end such a bill void it themselves).
--
-- Expand-only: a less strict unique index and a rollup that counts fewer rows.
-- Code that still deletes keeps working against it.
--
-- BACKFILL: every bill (not void) that already carries a voided line is rolled
-- up again with the new rule. Idempotent — a bill already right is left as it
-- is. Production had no voided payments rows on 10/12, so today it changes
-- nothing there; it catches any voided before this runs.

DROP INDEX IF EXISTS ux_payments_unit_rent_due_date_active;
CREATE UNIQUE INDEX ux_payments_unit_rent_due_date_active
    ON payments (unit_id, due_date)
    WHERE type = 'rent'
      AND status <> ALL (ARRAY['failed'::text, 'returned'::text, 'voided'::text])
      AND NOT is_remainder;

COMMENT ON INDEX ux_payments_unit_rent_due_date_active IS
  'S414/S407: one live rent row per (unit, due date). Failed, returned and (10/12) voided rows are left out — none of them is owed or paid, so a fresh row may take the month. Remainder rows (is_remainder) are the legitimate second row for a month.';

CREATE OR REPLACE FUNCTION public.fn_invoice_status_rollup_single(p_invoice_id uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_total_children   INTEGER;
  v_settled_children INTEGER;
  v_current_status   TEXT;
  v_new_status       TEXT;
BEGIN
  SELECT status INTO v_current_status FROM invoices WHERE id = p_invoice_id;
  IF v_current_status = 'void' THEN
    RETURN;
  END IF;

  -- 10/12 (Nic): a voided line (decisions #48.5) is owed by nobody and paid
  -- by nothing — it is a record, not a line of the bill, and is left out
  -- exactly as the deleted line it replaces was.
  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE status = 'settled')
  INTO v_total_children, v_settled_children
  FROM payments
  WHERE invoice_id = p_invoice_id
    AND status <> 'voided';

  IF v_total_children = 0 THEN
    v_new_status := 'pending';
  ELSIF v_settled_children = 0 THEN
    v_new_status := 'pending';
  ELSIF v_settled_children = v_total_children THEN
    v_new_status := 'settled';
  ELSE
    v_new_status := 'partial';
  END IF;

  IF v_new_status IS DISTINCT FROM v_current_status THEN
    UPDATE invoices
    SET status = v_new_status, updated_at = now()
    WHERE id = p_invoice_id;
  END IF;
END;
$$;

-- Backfill (idempotent): bills already carrying a voided line.
SELECT fn_invoice_status_rollup_single(i.id)
  FROM invoices i
 WHERE i.status <> 'void'
   AND EXISTS (SELECT 1 FROM payments p WHERE p.invoice_id = i.id AND p.status = 'voided');
