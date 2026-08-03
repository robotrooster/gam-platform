-- S575 (Nic): attach a receipt file to a manually-entered landlord expense.
-- Manual property/unit expenses (NOT bank-reconciliation ones) should let the
-- landlord upload the receipt so EVERY receipt is logged for taxes / cleaner
-- accounting. The file itself lives on disk under uploads/expense-receipts and
-- is served only through an authed route (gam-nothing-public-rule); these
-- columns hold the pointer + metadata.
--
-- No backfill needed — existing rows simply have no receipt (all NULL).
ALTER TABLE public.landlord_expenses
  ADD COLUMN IF NOT EXISTS receipt_url  text,
  ADD COLUMN IF NOT EXISTS receipt_name text,
  ADD COLUMN IF NOT EXISTS receipt_mime text,
  ADD COLUMN IF NOT EXISTS receipt_size integer;
