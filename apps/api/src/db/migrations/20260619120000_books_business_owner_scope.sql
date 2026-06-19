-- GAM Books: generalize ownership from landlord-only to landlord-OR-business.
--
-- WHY: business customers (apps/business — trash hauling, mechanics, mini-
-- markets, equipment rental) are getting full bookkeeping by REUSING the
-- existing GAM Books engine (Nic decision 2026-06-19) rather than a separate
-- lightweight ledger. Every owner-scoped Books table is currently keyed on
-- landlord_id (FK landlords). This adds a parallel, nullable business_id
-- (FK businesses) so the same tables can hold a business customer's books.
--
-- INVARIANT: a row belongs to AT MOST ONE owner. landlord_id XOR business_id,
-- with both-NULL still allowed because pre-existing system/template rows
-- (is_system chart-of-accounts seeds) carry a NULL landlord_id. Using
-- num_nonnulls(...) <= 1 keeps those rows valid and needs NO backfill — every
-- existing row already has business_id NULL, so it satisfies the check.
--
-- The route layer (routes/books.ts) resolves the active owner column per
-- request (landlord_id for landlord/bookkeeper/PM, business_id for
-- business_owner) and every query targets exactly one column, so the two
-- owner namespaces never mix.
--
-- SAFE: purely additive (new nullable column + FK + partial index + check).
-- No data change to existing landlord rows. No backfill needed.

ALTER TABLE public.books_accounts        ADD COLUMN business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.books_bills           ADD COLUMN business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.books_contractors     ADD COLUMN business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.books_employees       ADD COLUMN business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.books_transactions    ADD COLUMN business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.books_vendors         ADD COLUMN business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.journal_entries       ADD COLUMN business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.payroll_runs          ADD COLUMN business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.bank_reconciliations  ADD COLUMN business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;

-- At-most-one-owner invariant per table.
ALTER TABLE public.books_accounts        ADD CONSTRAINT books_accounts_one_owner        CHECK (num_nonnulls(landlord_id, business_id) <= 1);
ALTER TABLE public.books_bills           ADD CONSTRAINT books_bills_one_owner           CHECK (num_nonnulls(landlord_id, business_id) <= 1);
ALTER TABLE public.books_contractors     ADD CONSTRAINT books_contractors_one_owner     CHECK (num_nonnulls(landlord_id, business_id) <= 1);
ALTER TABLE public.books_employees       ADD CONSTRAINT books_employees_one_owner       CHECK (num_nonnulls(landlord_id, business_id) <= 1);
ALTER TABLE public.books_transactions    ADD CONSTRAINT books_transactions_one_owner    CHECK (num_nonnulls(landlord_id, business_id) <= 1);
ALTER TABLE public.books_vendors         ADD CONSTRAINT books_vendors_one_owner         CHECK (num_nonnulls(landlord_id, business_id) <= 1);
ALTER TABLE public.journal_entries       ADD CONSTRAINT journal_entries_one_owner       CHECK (num_nonnulls(landlord_id, business_id) <= 1);
ALTER TABLE public.payroll_runs          ADD CONSTRAINT payroll_runs_one_owner          CHECK (num_nonnulls(landlord_id, business_id) <= 1);
ALTER TABLE public.bank_reconciliations  ADD CONSTRAINT bank_reconciliations_one_owner  CHECK (num_nonnulls(landlord_id, business_id) <= 1);

-- Per-owner lookup indexes (partial — only business-owned rows).
CREATE INDEX idx_books_accounts_business       ON public.books_accounts       (business_id) WHERE business_id IS NOT NULL;
CREATE INDEX idx_books_bills_business          ON public.books_bills          (business_id) WHERE business_id IS NOT NULL;
CREATE INDEX idx_books_contractors_business    ON public.books_contractors    (business_id) WHERE business_id IS NOT NULL;
CREATE INDEX idx_books_employees_business      ON public.books_employees      (business_id) WHERE business_id IS NOT NULL;
CREATE INDEX idx_books_transactions_business   ON public.books_transactions   (business_id) WHERE business_id IS NOT NULL;
CREATE INDEX idx_books_vendors_business        ON public.books_vendors        (business_id) WHERE business_id IS NOT NULL;
CREATE INDEX idx_journal_entries_business      ON public.journal_entries      (business_id) WHERE business_id IS NOT NULL;
CREATE INDEX idx_payroll_runs_business         ON public.payroll_runs         (business_id) WHERE business_id IS NOT NULL;
CREATE INDEX idx_bank_reconciliations_business ON public.bank_reconciliations (business_id) WHERE business_id IS NOT NULL;
