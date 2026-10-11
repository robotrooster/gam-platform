-- 10/6 (Nic) — "Do you allow tenants to go into the bank and deposit their rent
-- for this unit or for this property? We don't do that here at Mountain View."
--
-- A per-property setting, default OFF: tenants may deposit rent directly at the
-- landlord's bank. It decides three things, all read from this column:
--
--   ON  — the tenant portal offers "Report a bank deposit"; the landlord's
--         Record payment / Post a payment offer "Bank deposit"; the bank feed
--         matches bank lines to tenants' bills there by itself (a tenant's
--         report the bank confirms, a whole bill to the cent, a deposit the
--         office already recorded by hand).
--   OFF — none of that: the report is refused, the "Bank deposit" method is
--         refused, and the bank feed never matches a bank line to a tenant's
--         bill there by itself. The office's own cash and check deposits keep
--         their deposit-slip matching (that is the office's money, not a
--         tenant's deposit).
--
-- Why it matters (Nic, 10/6): when a bank line is matched to a tenant's bill,
-- the BANK's date decides whether a late fee was ever owed. At a property where
-- tenants never go to the bank, every deposit is the office's — large, mixed
-- with petty cash and change for propane — and can never be read as one
-- tenant's payment.
--
-- Backfill: none. Every property starts OFF (Mountain View and Oak Park stay
-- OFF). Country Acres is turned ON by a data step after deploy, not here.
-- Safe drop: the column (nothing else depends on it).

ALTER TABLE public.properties ADD COLUMN IF NOT EXISTS tenants_deposit_at_bank boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.properties.tenants_deposit_at_bank IS
  '10/6 (Nic): tenants may deposit rent directly at the landlord''s bank. ON: the tenant may report a bank deposit, the landlord may record a "Bank deposit", and the bank feed matches bank lines to tenants'' bills here by itself (the bank''s date decides late fees). OFF (default): all three are refused; the office''s own deposit slips still match.';
