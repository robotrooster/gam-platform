-- Home-sale installment billing idempotency (S594, Nic — money-path hardening).
--
-- WHY: billDueHomeSaleInstallments creates a type='home_payment' charge per due
-- installment and stamps installment.payment_id. Its only idempotency was the
-- `payment_id IS NULL` filter — safe under a single-threaded cron, but every
-- OTHER money-charge type (rent/fee/late_fee) also carries a ux_payments_*
-- partial-unique backstop so a second cron-enabled API instance (or an
-- overlapping tick) can't double-charge. Home-sale was the lone exception.
--
-- FIX: stamp the driving installment id ON the payment and make it 1:1 unique.
-- A naive (lease_id, due_date) index would false-conflict when a contract is
-- cancelled and a NEW contract is created on the same unit/month, so the key is
-- the installment id itself. The billing loop uses ON CONFLICT DO NOTHING, so a
-- concurrent/duplicate run is a no-op instead of a second charge.
--
-- SAFE: additive nullable column; the FK is ON DELETE SET NULL (matches the
-- existing home_sale_installments.payment_id → payments FK, and keeps the
-- cyclic pair non-blocking on delete). Partial index only constrains non-null
-- values, so existing payments (all NULL here) are unaffected. No backfill.

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS home_sale_installment_id uuid;

ALTER TABLE public.payments
  DROP CONSTRAINT IF EXISTS payments_home_sale_installment_id_fkey;
ALTER TABLE public.payments
  ADD CONSTRAINT payments_home_sale_installment_id_fkey
  FOREIGN KEY (home_sale_installment_id)
  REFERENCES public.home_sale_installments(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_payments_home_sale_installment
  ON public.payments (home_sale_installment_id)
  WHERE (home_sale_installment_id IS NOT NULL);

COMMENT ON COLUMN public.payments.home_sale_installment_id IS
  'S594: the home_sale_installments row this home_payment charge bills. Partial-unique so an installment is billed at most once even across concurrent cron runs / multiple API instances.';
