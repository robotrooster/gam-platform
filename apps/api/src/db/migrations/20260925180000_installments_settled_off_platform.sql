-- S652 (Nic): an installment contract keeps its true terms (a sale that began in
-- 2021 still has 120 payments from January 2021) but GAM bills only from the
-- property's first billing cycle. Installments before that were paid outside
-- GAM: stamped here, never billed, counted as paid.
ALTER TABLE home_sale_installments ADD COLUMN IF NOT EXISTS settled_off_platform_at TIMESTAMPTZ;
