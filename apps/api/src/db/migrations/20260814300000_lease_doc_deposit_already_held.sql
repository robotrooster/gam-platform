-- S604 (Nic): deposit already in custody — migration onboarding.
--
-- THE PROBLEM: a landlord onboarding EXISTING tenants onto GAM has them e-sign
-- new leases. buildLeaseFromDocument calls generateMoveInInvoice
-- UNCONDITIONALLY, which bills every lease_fees row with due_timing='move_in' —
-- including the security deposit. Oak Park would have issued 19 tenants a $350
-- deposit invoice for money the landlord ALREADY HOLDS (~$6,650 of wrong bills
-- to sitting tenants on day one).
--
-- Setting the deposit to $0 on the document is not acceptable: the signed lease
-- would misstate the deposit, which is a legal document.
--
-- THE SHAPE ALREADY EXISTS for renewals. esign.ts carries a predecessor deposit
-- forward "so [the fees] exist for the final move-out deposit sweep without
-- being re-billed (the tenant already paid them on the original lease)". That is
-- exactly this case — existing tenant, deposit already paid, new lease document.
-- It just keys off renews_lease_id, and a migrated tenant has no predecessor
-- lease in GAM because they predate the platform.
--
-- THE FIX: an explicit per-document flag. When set, the lease still STATES the
-- correct deposit amount (the lease_fees row is written normally, so the signed
-- document and the move-out sweep are both right), but the deposit is EXCLUDED
-- from the move-in invoice and its security_deposits row is created already
-- funded and landlord-held.
--
-- Default FALSE: a genuinely new tenant must still be billed their deposit.
-- No backfill — every existing document is a normal new-tenant lease.

ALTER TABLE lease_documents
  ADD COLUMN IF NOT EXISTS deposit_already_held boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN lease_documents.deposit_already_held IS
  'S604: TRUE = the landlord already holds this tenant''s security deposit (migration onboarding). The lease still states the deposit amount, but it is excluded from the move-in invoice and the security_deposits row is created funded + held_by=landlord. Default false — new tenants are billed normally.';
