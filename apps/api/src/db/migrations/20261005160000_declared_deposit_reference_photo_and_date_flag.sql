-- 10/5 (Nic) — a tenant's "I paid at the bank" report: the reference number,
-- a photo of the bank's receipt, and the date the bank proves.
--
-- Nic: "When they record the payment themselves in their portal, it needs to
-- have the date of the deposit as well... When we get to the bank
-- reconciliation stage, if they mark that they paid... not only do we match
-- the deposit on the bank feed but if they say they paid on time and it was
-- actually late we need to make sure that they get the late fee and then they
-- get flagged for false information."
--
-- Three things on tenant_declared_deposits:
--
--   1. The deposit reference number from the bank's receipt is now REQUIRED on
--      a new report (routes/declaredDeposits.ts refuses one without it). It is
--      not a NOT NULL / CHECK here: reports made before today have none, and a
--      CHECK would also refuse every later status change on them (the expiry
--      job, a bank match). The server is the rule.
--   2. An optional photo of the bank's receipt (receipt_photo_*), stored like
--      the landlord's bank-deposit receipt photo: an unguessable file name
--      behind an authed route (GET /api/declared-deposits/receipt-photos/<file>)
--      that authorizes per row — the tenant who made the report, or that
--      landlord's own people at a property they work at. Never public.
--   3. The bank's date. When a bank deposit confirms a report
--      (services/bankDepositConfirm.ts) the day the bank posted it is kept
--      (bank_posted_date). The tenant's date counts only if the bank posted
--      the deposit that day or the next business day after it (weekends and
--      bank holidays roll forward). Later than that, the stated date was
--      false: the bank's date decides the late fees, the deposit still pays
--      the bill, and the report is flagged (false_date_flagged_at). A flagged
--      report is a strike toward the report button's trust, the same as a
--      report whose deposit never came (routes/declaredDeposits.ts
--      DECLARATION_STRIKE_SQL). Undoing the match clears both.
--
-- No backfill needed: no report has a photo, and no confirmed report was
-- judged by the next-business-day rule (they keep bank_posted_date NULL and
-- are never flagged after the fact). Safe drop: the seven columns, the CHECK
-- and the index.

ALTER TABLE public.tenant_declared_deposits ADD COLUMN IF NOT EXISTS receipt_photo_url text;
ALTER TABLE public.tenant_declared_deposits ADD COLUMN IF NOT EXISTS receipt_photo_name text;
ALTER TABLE public.tenant_declared_deposits ADD COLUMN IF NOT EXISTS receipt_photo_mime text;
ALTER TABLE public.tenant_declared_deposits ADD COLUMN IF NOT EXISTS receipt_photo_size integer;
ALTER TABLE public.tenant_declared_deposits ADD COLUMN IF NOT EXISTS receipt_photo_uploaded_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS ux_tenant_declared_deposits_receipt_photo_url
  ON public.tenant_declared_deposits (receipt_photo_url) WHERE receipt_photo_url IS NOT NULL;

ALTER TABLE public.tenant_declared_deposits ADD COLUMN IF NOT EXISTS bank_posted_date date;
ALTER TABLE public.tenant_declared_deposits ADD COLUMN IF NOT EXISTS false_date_flagged_at timestamptz;
ALTER TABLE public.tenant_declared_deposits DROP CONSTRAINT IF EXISTS tenant_declared_deposits_flag_has_bank_date;
ALTER TABLE public.tenant_declared_deposits ADD CONSTRAINT tenant_declared_deposits_flag_has_bank_date
  CHECK (false_date_flagged_at IS NULL OR (bank_posted_date IS NOT NULL AND bank_posted_date > declared_date));

COMMENT ON COLUMN public.tenant_declared_deposits.receipt_photo_url IS
  '10/5 (Nic): the tenant''s photo of the bank''s deposit receipt (authed route /api/declared-deposits/receipt-photos/<file>, per-row authorization: the tenant who reported it, or that landlord''s own people at a property they work at).';
COMMENT ON COLUMN public.tenant_declared_deposits.bank_posted_date IS
  '10/5 (Nic): the day the bank posted the deposit that confirmed this report. The reported date counts only when this is that day or the next business day after it.';
COMMENT ON COLUMN public.tenant_declared_deposits.false_date_flagged_at IS
  '10/5 (Nic): the bank posted this deposit later than the next business day after the reported date, so the reported date was false: the bank''s date decided the late fees, and this report counts as a strike toward the report button''s trust.';
