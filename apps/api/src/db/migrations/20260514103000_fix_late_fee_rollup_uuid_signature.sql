-- S275: late_fee_subtotal_rollup function signature fix.
--
-- The initial schema (20260429202524_initial_schema.sql) declared
-- `fn_invoice_late_fee_subtotal_rollup_single(p_invoice_id integer)`,
-- but `invoices.id` is `uuid`. The trigger
-- `trg_payments_invoice_late_fee_subtotal_rollup` calls the function
-- with `NEW.invoice_id` (uuid) — Postgres can't resolve the
-- (integer)-argument function for a uuid input, so every late-fee
-- INSERT/UPDATE/DELETE errors with
-- `function fn_invoice_late_fee_subtotal_rollup_single(uuid) does
-- not exist`.
--
-- Effect in prod: late fees would never write. Caught by the lease-
-- lifecycle test suite (S275) before launch.
--
-- Fix: drop the bad signature and re-create with uuid. The trigger
-- function (which is signature-agnostic and just PERFORMs by name)
-- starts resolving to the correct overload automatically.

DROP FUNCTION IF EXISTS public.fn_invoice_late_fee_subtotal_rollup_single(integer);

CREATE FUNCTION public.fn_invoice_late_fee_subtotal_rollup_single(p_invoice_id uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE invoices
  SET subtotal_late_fees = COALESCE((
    SELECT SUM(amount)
    FROM payments
    WHERE invoice_id = p_invoice_id
      AND type = 'late_fee'
      AND status IN ('pending', 'processing', 'settled')
  ), 0)
  WHERE id = p_invoice_id;
END;
$$;
