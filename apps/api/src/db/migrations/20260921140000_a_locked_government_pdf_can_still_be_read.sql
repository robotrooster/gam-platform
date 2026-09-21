-- S652 — A LOCKED GOVERNMENT PDF CAN STILL BE ON THE SHELF, TO READ.
--
-- Nic: "If the government provides a document, we are adding it to the library.
-- That's it." IEMA's "Radon Testing Guidelines for Real Estate Transactions" is
-- encrypted against editing, and signing works by stamping names and initials
-- onto the page — which the lock refuses, and which removing the lock would
-- make an altered document. So it is shelved as READ-ONLY: it can be viewed and
-- handed over, but not adopted into a template or put in a signing packet.
--
-- No backfill needed: every existing entry is signable.

ALTER TABLE disclosure_library_documents
  ADD COLUMN signable boolean NOT NULL DEFAULT true;
