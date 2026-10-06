-- 10/5 (Nic) — residents who pay by walking into the bank, and part payments.
--
-- In Mattoon (Country Acres) residents "go into the bank and deposit cash into
-- the bank". Until the bank feed is verified the office logs those deposits by
-- hand, and asked for three things:
--
--   1. "Bank deposit" as its own way to record a payment, with "a reference
--      number to the bank deposit in case somebody else happens to deposit the
--      same amount" (packages/shared MANUAL_PAYMENT_METHODS gains
--      'bank_deposit'; the two CHECKs below list the same values).
--   2. "maybe ... add a picture of the receipt" — an optional photo of the
--      bank's deposit receipt, kept on the desk receipt (tenant_remittances)
--      and served only to that landlord's own people (per-row authorization in
--      routes/payments.ts; never a public URL, never shown to the tenant). A
--      photo belongs only on a bank deposit (CHECK below).
--   3. "there's really no way to stop somebody from going into the bank and
--      making a partial ... We need that to log that and still be able to
--      charge late fees to the people that didn't pay in full." — a
--      per-property "Accept partial payments" setting, default OFF. It applies
--      to RECORDED payments only (cash, check, money order, bank deposit);
--      tenants paying online still pay in full.
--
-- The three are one change: the bank deposit is why partial payments are
-- needed, and the photo exists only for the bank deposit.
--
-- No backfill needed: every existing payment and receipt keeps its method, no
-- receipt has a photo, and every property starts with partial payments OFF
-- (today's pay-in-full behavior). Safe drop: the four photo columns and their
-- CHECK, and properties.accept_partial_payments; the two method CHECKs go back
-- to their old lists only once no row carries 'bank_deposit'.

-- 1. The method, on the charge and on the receipt.
ALTER TABLE public.payments DROP CONSTRAINT IF EXISTS payments_manual_method_check;
ALTER TABLE public.payments ADD CONSTRAINT payments_manual_method_check
  CHECK (manual_method IS NULL OR manual_method = ANY (ARRAY['cash', 'check', 'money_order', 'bank_deposit', 'prior_arrangement']));

ALTER TABLE public.tenant_remittances DROP CONSTRAINT IF EXISTS tenant_remittances_payment_method_check;
ALTER TABLE public.tenant_remittances ADD CONSTRAINT tenant_remittances_payment_method_check
  CHECK (payment_method = ANY (ARRAY['ach', 'card', 'cash', 'check', 'money_order', 'bank_deposit']));

-- 2. The photo of the bank's deposit receipt.
ALTER TABLE public.tenant_remittances ADD COLUMN IF NOT EXISTS deposit_photo_url text;
ALTER TABLE public.tenant_remittances ADD COLUMN IF NOT EXISTS deposit_photo_name text;
ALTER TABLE public.tenant_remittances ADD COLUMN IF NOT EXISTS deposit_photo_mime text;
ALTER TABLE public.tenant_remittances ADD COLUMN IF NOT EXISTS deposit_photo_size integer;
ALTER TABLE public.tenant_remittances ADD COLUMN IF NOT EXISTS deposit_photo_uploaded_by uuid;
ALTER TABLE public.tenant_remittances ADD COLUMN IF NOT EXISTS deposit_photo_uploaded_at timestamptz;
ALTER TABLE public.tenant_remittances DROP CONSTRAINT IF EXISTS tenant_remittances_deposit_photo_bank_deposit_only;
ALTER TABLE public.tenant_remittances ADD CONSTRAINT tenant_remittances_deposit_photo_bank_deposit_only
  CHECK (deposit_photo_url IS NULL OR payment_method = 'bank_deposit');
CREATE UNIQUE INDEX IF NOT EXISTS ux_tenant_remittances_deposit_photo_url
  ON public.tenant_remittances (deposit_photo_url) WHERE deposit_photo_url IS NOT NULL;

COMMENT ON COLUMN public.tenant_remittances.deposit_photo_url IS
  '10/5 (Nic): the photo of the bank''s deposit receipt for a recorded bank deposit (authed route /api/payments/deposit-photos/<file>, per-row authorization). Never shown to the tenant.';

-- 3. Partial payments, per property.
ALTER TABLE public.properties ADD COLUMN IF NOT EXISTS accept_partial_payments boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.properties.accept_partial_payments IS
  '10/5 (Nic): a payment RECORDED here (cash, check, money order, bank deposit) may be less than what is owed: it pays the oldest bills first, a rent bill it does not cover stays open for the rest, and late fees keep applying to it. Online payments still pay in full. Default off.';
