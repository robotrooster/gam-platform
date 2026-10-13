-- 10/11 (Nic) — GAM BOOKS: REMOVING A CASH TRANSACTION HIDES IT
--
-- DELETE /books/transactions/:id hard-deleted the row. GAM never erases what
-- someone recorded (keep-everything rule): a "delete" hides the row from every
-- screen and report and keeps it, with who removed it and when.
--
-- Every reader of books_transactions in routes/books.ts (the Transactions list,
-- edit and reconcile, Bank Reconciliation, the Cash Flow report) now reads
-- only rows WHERE deleted_at IS NULL.
--
-- Backfill: none — every existing row is live (deleted_at NULL).
-- Safe drop: both columns, once nothing reads them.

ALTER TABLE books_transactions
  ADD COLUMN deleted_at timestamptz NULL,
  ADD COLUMN deleted_by uuid NULL REFERENCES users(id) ON DELETE SET NULL;
