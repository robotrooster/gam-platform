-- S581 (Nic): terms-addendum delivery mode + tenant lease notices.
--
-- WHY: a money add-on comes in two shapes (Nic):
--   * AGREEMENT — the tenant OPTS IN (parking, garage) and signs to accept. The
--     existing addendum flow (landlord + all active tenants sign) already covers
--     this; the change takes effect once fully signed.
--   * NOTICE — the landlord has the right to make the change with notice (e.g. AZ
--     mobile-home space-rent increase). The tenant does NOT sign — it is not
--     optional. The landlord issues it; it takes effect on the effective date
--     regardless. We still record that the tenant SAW it (proof of notice) and
--     surface it as a blocking pop-up on their next portal login that they must
--     Acknowledge to dismiss.
--
-- lease_documents.delivery_mode marks which shape an addendum is. 'agreement' is
-- the default so every existing document keeps its current signed-by-all flow.
--
-- lease_notices drives the tenant portal pop-up + captures viewed/acknowledged.
-- One row per affected tenant, created when a NOTICE addendum completes (landlord
-- signs). GAM never decides which mode applies to a given change — the landlord
-- chooses per add-on, per their local law (no state-specific legal logic).

ALTER TABLE lease_documents
  ADD COLUMN IF NOT EXISTS delivery_mode text NOT NULL DEFAULT 'agreement'
    CHECK (delivery_mode IN ('agreement', 'notice'));

CREATE TABLE lease_notices (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id           uuid NOT NULL REFERENCES leases(id) ON DELETE CASCADE,
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_document_id uuid REFERENCES lease_documents(id) ON DELETE SET NULL,
  title              text NOT NULL,
  body               text NOT NULL,           -- the gist shown in the pop-up
  effective_date     date,                    -- when the underlying change takes effect
  status             text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'acknowledged')),
  viewed_at          timestamp with time zone,   -- first time the tenant opened it
  acknowledged_at    timestamp with time zone,   -- clicked Acknowledge to dismiss
  created_at         timestamp with time zone DEFAULT now(),
  updated_at         timestamp with time zone DEFAULT now()
);

-- The portal pop-up query: this tenant's still-pending (un-acknowledged) notices.
CREATE INDEX ix_lease_notices_tenant_pending
  ON lease_notices (tenant_id)
  WHERE status = 'pending';

CREATE INDEX ix_lease_notices_doc ON lease_notices (source_document_id);
