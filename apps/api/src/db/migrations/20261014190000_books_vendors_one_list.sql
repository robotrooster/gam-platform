-- 10/12 (Nic) — GAM BOOKS: ONE LIST OF EVERYONE THE COMPANY PAYS
--
-- Nic, 10/12: "VENDORS = one list of everyone the company pays (contractors,
-- the garbage company, the power company) with a type; contractors get a 1099
-- box and their payments add up per calendar year." Books kept two lists — the
-- Vendors page (books_vendors) and a separate Contractors (1099) page
-- (books_contractors) — and the 1099 total on a contractor (ytd_paid) was a
-- running number nothing ever added to (gam-ledger-design-2026-10-12 §12).
--
-- books_vendors becomes the one list:
--   vendor_type          contractor / utility / supplier / other
--                        (BOOKS_VENDOR_TYPES, packages/shared/src/booksVendorsLoans.ts)
--   is_1099              the 1099 box — only a contractor carries it. What a
--                        1099 vendor was paid in a calendar year is worked out
--                        from the payments made to it (landlord_expense_payments
--                        on its expenses), never kept as a running total.
--   tax_classification   the box ticked on the payee's Form W-9
--                        (BOOKS_W9_TAX_CLASSIFICATIONS); optional
--   ssn_last4            the last four of an individual's Social Security
--                        number (what the Contractors page kept); the taxpayer
--                        id itself (tax_id) stays optional
--   w9_on_file           whether the company has the payee's W-9
--   trade, pay_rate, pay_unit   a contractor's trade and usual rate (what the
--                        Contractors page kept)
--   tenant_id            a work trader the company pays for extra hours as a
--                        contractor (1099): their one vendor row, so every
--                        payment to them adds up on one 1099
--   migrated_from_contractor_id  the Contractors row a vendor was folded from
--
-- THE FOLD: every books_contractors row becomes a vendor of type contractor
-- with the 1099 box, keeping a pointer to where it came from. The contractor
-- rows stay as they were (keep-everything; nothing reads them once the code
-- ships). The running ytd_paid is not copied: the 1099 total is the payments.
-- A contractor saved before 10/11 with the classification 'business' folds
-- with the classification blank (the contractor row keeps the word).
--
-- THE WINDOW: this runs before the code that retires the Contractors page
-- ships. Until then the old page may still add or change a contractor, so a
-- trigger folds each new contractor the moment it is saved and keeps its
-- vendor in step when it changes. Once the code ships nothing writes
-- books_contractors and the trigger never fires again.
--
-- Production on 10/12 (read-only count): 0 contractors, 0 vendors.
-- Expand-only; safe before the code ships. Backfill: the fold above
-- (idempotent — a contractor already folded is skipped).
-- Safe drop: the trigger and function, the new columns, their CHECKs and
-- indexes (the folded vendor rows are then ordinary vendors).

SET LOCAL lock_timeout = '10s';

ALTER TABLE books_vendors
  ADD COLUMN IF NOT EXISTS vendor_type                 text NOT NULL DEFAULT 'other',
  ADD COLUMN IF NOT EXISTS is_1099                     boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS tax_classification          text,
  ADD COLUMN IF NOT EXISTS ssn_last4                   varchar(4),
  ADD COLUMN IF NOT EXISTS w9_on_file                  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS trade                       varchar(100),
  ADD COLUMN IF NOT EXISTS pay_rate                    numeric(10,2),
  ADD COLUMN IF NOT EXISTS pay_unit                    varchar(20),
  ADD COLUMN IF NOT EXISTS tenant_id                   uuid REFERENCES tenants(id),
  ADD COLUMN IF NOT EXISTS migrated_from_contractor_id uuid REFERENCES books_contractors(id);

ALTER TABLE books_vendors DROP CONSTRAINT IF EXISTS books_vendors_type_check;
ALTER TABLE books_vendors ADD CONSTRAINT books_vendors_type_check
  CHECK (vendor_type IN ('contractor', 'utility', 'supplier', 'other'));
-- Only a contractor carries the 1099 box.
ALTER TABLE books_vendors DROP CONSTRAINT IF EXISTS books_vendors_1099_is_contractor;
ALTER TABLE books_vendors ADD CONSTRAINT books_vendors_1099_is_contractor
  CHECK (NOT is_1099 OR vendor_type = 'contractor');
ALTER TABLE books_vendors DROP CONSTRAINT IF EXISTS books_vendors_tax_classification_check;
ALTER TABLE books_vendors ADD CONSTRAINT books_vendors_tax_classification_check
  CHECK (tax_classification IS NULL OR tax_classification IN ('individual', 'c_corp', 's_corp', 'partnership', 'llc', 'other'));
ALTER TABLE books_vendors DROP CONSTRAINT IF EXISTS books_vendors_ssn_last4_check;
ALTER TABLE books_vendors ADD CONSTRAINT books_vendors_ssn_last4_check
  CHECK (ssn_last4 IS NULL OR ssn_last4 ~ '^[0-9]{4}$');
ALTER TABLE books_vendors DROP CONSTRAINT IF EXISTS books_vendors_pay_unit_check;
ALTER TABLE books_vendors ADD CONSTRAINT books_vendors_pay_unit_check
  CHECK (pay_unit IS NULL OR pay_unit IN ('project', 'hour', 'day', 'sqft'));
ALTER TABLE books_vendors DROP CONSTRAINT IF EXISTS books_vendors_pay_rate_check;
ALTER TABLE books_vendors ADD CONSTRAINT books_vendors_pay_rate_check
  CHECK (pay_rate IS NULL OR pay_rate > 0);
-- A work trader paid as a contractor is a contractor, of a landlord company.
ALTER TABLE books_vendors DROP CONSTRAINT IF EXISTS books_vendors_tenant_is_contractor;
ALTER TABLE books_vendors ADD CONSTRAINT books_vendors_tenant_is_contractor
  CHECK (tenant_id IS NULL OR (vendor_type = 'contractor' AND landlord_id IS NOT NULL));

-- One vendor per work trader per company; one vendor per folded contractor.
CREATE UNIQUE INDEX IF NOT EXISTS books_vendors_one_per_tenant
  ON books_vendors (landlord_id, tenant_id) WHERE tenant_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS books_vendors_one_per_contractor
  ON books_vendors (migrated_from_contractor_id) WHERE migrated_from_contractor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS books_vendors_landlord_type ON books_vendors (landlord_id, vendor_type) WHERE landlord_id IS NOT NULL;

COMMENT ON COLUMN books_vendors.vendor_type IS
  '10/12 (Nic): what kind of payee — contractor, utility, supplier, other (BOOKS_VENDOR_TYPES). One list of everyone the company pays.';
COMMENT ON COLUMN books_vendors.is_1099 IS
  '10/12 (Nic): the 1099 box — only a contractor. The year''s total is the payments made to it (landlord_expense_payments on its expenses, by paid_on), never a running number.';
COMMENT ON COLUMN books_vendors.tax_classification IS
  '10/12: the box ticked on the payee''s Form W-9 (BOOKS_W9_TAX_CLASSIFICATIONS); optional.';
COMMENT ON COLUMN books_vendors.tenant_id IS
  '10/12 (Nic): the work trader this contractor is, paid for extra hours as a contractor (1099) — their one vendor row.';
COMMENT ON COLUMN books_vendors.migrated_from_contractor_id IS
  '10/12 (Nic): the Contractors (1099) row this vendor was folded from. The contractor row stays as it was.';
COMMENT ON COLUMN books_vendors.ytd_paid IS
  '10/12: no longer read — a 1099 vendor''s year is worked out from its payments. Kept as it was (keep-everything).';

-- ── The fold, and the window ────────────────────────────────────────────────
-- One contractor row as its vendor's fields.
CREATE OR REPLACE FUNCTION books_contractor_vendor_fields(c books_contractors)
RETURNS TABLE (name text, contact_name text, tax_classification text, tax_id text, ssn_last4 text,
               pay_unit text, status text)
LANGUAGE sql IMMUTABLE AS $$
  SELECT left(COALESCE(NULLIF(btrim(c.business_name), ''),
                       NULLIF(btrim(concat_ws(' ', btrim(c.first_name), btrim(c.last_name))), ''),
                       'Contractor'), 200),
         left(NULLIF(btrim(concat_ws(' ', btrim(c.first_name), btrim(c.last_name))), ''), 200),
         CASE WHEN c.entity_type IN ('individual', 'c_corp', 's_corp', 'partnership', 'llc', 'other') THEN c.entity_type END,
         NULLIF(btrim(c.ein), ''),
         CASE WHEN c.ssn_last4 ~ '^[0-9]{4}$' THEN c.ssn_last4 END,
         CASE WHEN c.pay_unit IN ('project', 'hour', 'day', 'sqft') THEN c.pay_unit END,
         CASE WHEN c.status IS NULL OR c.status = 'active' THEN 'active' ELSE 'inactive' END
$$;

INSERT INTO books_vendors (landlord_id, business_id, name, contact_name, email, phone, address, payment_terms,
                           vendor_type, is_1099, tax_classification, tax_id, ssn_last4, w9_on_file,
                           trade, pay_rate, pay_unit, status, created_at, updated_at, migrated_from_contractor_id)
SELECT c.landlord_id, c.business_id, f.name, f.contact_name, c.email, c.phone, c.address, NULL,
       'contractor', TRUE, f.tax_classification, f.tax_id, f.ssn_last4, COALESCE(c.w9_on_file, FALSE),
       c.trade, CASE WHEN c.pay_rate > 0 THEN c.pay_rate END, f.pay_unit, f.status,
       COALESCE(c.created_at, now()), COALESCE(c.updated_at, now()), c.id
  FROM books_contractors c
 CROSS JOIN LATERAL books_contractor_vendor_fields(c) f
 WHERE NOT EXISTS (SELECT 1 FROM books_vendors v WHERE v.migrated_from_contractor_id = c.id);

-- Until the code ships: a contractor saved on the old page is folded at once,
-- and a change to it reaches its vendor.
CREATE OR REPLACE FUNCTION books_contractors_fold() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  f record;
BEGIN
  SELECT * INTO f FROM books_contractor_vendor_fields(NEW);
  IF NOT EXISTS (SELECT 1 FROM books_vendors v WHERE v.migrated_from_contractor_id = NEW.id) THEN
    INSERT INTO books_vendors (landlord_id, business_id, name, contact_name, email, phone, address, payment_terms,
                               vendor_type, is_1099, tax_classification, tax_id, ssn_last4, w9_on_file,
                               trade, pay_rate, pay_unit, status, migrated_from_contractor_id)
    VALUES (NEW.landlord_id, NEW.business_id, f.name, f.contact_name, NEW.email, NEW.phone, NEW.address, NULL,
            'contractor', TRUE, f.tax_classification, f.tax_id, f.ssn_last4, COALESCE(NEW.w9_on_file, FALSE),
            NEW.trade, CASE WHEN NEW.pay_rate > 0 THEN NEW.pay_rate END, f.pay_unit, f.status, NEW.id);
  ELSIF TG_OP = 'UPDATE' THEN
    UPDATE books_vendors v
       SET name = f.name, contact_name = f.contact_name, email = NEW.email, phone = NEW.phone, address = NEW.address,
           tax_classification = f.tax_classification, tax_id = f.tax_id, ssn_last4 = f.ssn_last4,
           w9_on_file = COALESCE(NEW.w9_on_file, FALSE), trade = NEW.trade,
           pay_rate = CASE WHEN NEW.pay_rate > 0 THEN NEW.pay_rate END, pay_unit = f.pay_unit, status = f.status,
           updated_at = now()
     WHERE v.migrated_from_contractor_id = NEW.id;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS books_contractors_fold ON books_contractors;
CREATE TRIGGER books_contractors_fold AFTER INSERT OR UPDATE ON books_contractors
  FOR EACH ROW EXECUTE FUNCTION books_contractors_fold();

COMMENT ON FUNCTION books_contractors_fold() IS
  '10/12 (Nic): the Contractors list folded into the one Vendors list; until the code that retires the Contractors page ships, a contractor saved there is folded (and kept in step) at once.';
