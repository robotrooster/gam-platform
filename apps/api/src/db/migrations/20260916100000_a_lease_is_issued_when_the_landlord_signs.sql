-- S647 — THE LEASE BECOMES REAL WHEN THE LANDLORD SIGNS.
--
-- Nic (S647, DIRECTIVE): "Bill it out to everybody upon my signature." And on
-- the order: "My signature is done before they even accept, right? That way
-- their accept and sign is all one flow."
--
-- Until now a lease row — and its move-in invoice — appeared only when the LAST
-- signer finished. So a household that accepted a portal invite and then never
-- signed produced nothing at all: no lease, no charge, no balance. Thirteen
-- households are sitting in exactly that state right now, ten of them with a
-- draft document already waiting, and the landlord has no way to bill any of
-- them without chasing a signature first.
--
-- After this, the landlord's signature is the event that creates the lease and
-- the first invoice. The tenant's signature still matters — it executes the
-- document and is recorded honestly — but it no longer gates whether anybody
-- can be billed.
--
-- WHAT THIS IS NOT: a second billing path. generateMoveInInvoice remains the
-- one and only thing that produces a first invoice, called from the one place
-- it was always called from (buildLeaseFromDocument). All that changed is WHEN
-- that function runs.

-- When the landlord's signature built the lease. Distinct from completed_at,
-- which still means every signer is done, and from finalized_at, which is the
-- builder's own idempotency stamp.
--
-- It also answers a question the completion path has to ask: a document that
-- arrives at "all signed" with a lease already built is now the NORMAL case
-- rather than evidence of a concurrent double-finalize, and the two must not be
-- confused or every executed lease would skip its PDF stamp and its emails.
ALTER TABLE lease_documents
  ADD COLUMN IF NOT EXISTS issued_at timestamptz;

COMMENT ON COLUMN lease_documents.issued_at IS
  'S647: when the landlord signed and the lease + move-in invoice were created. '
  'NULL means not yet issued. completed_at still means every signer is done.';

-- The pipeline reads "issued but not executed" constantly — it is the call list.
CREATE INDEX IF NOT EXISTS idx_lease_documents_issued_unexecuted
  ON lease_documents (landlord_id, issued_at)
  WHERE issued_at IS NOT NULL AND completed_at IS NULL;
