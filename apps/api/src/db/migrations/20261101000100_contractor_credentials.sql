-- Contractor marketplace — the credentials a contractor uploads.
--
-- 10/31 (Nic): "The contractor uploads all their credentials. And when the
-- landlord is putting the job out, you know, they mark if they're requiring it
-- to be by a bonded and insured person."
--
-- This table holds the credentials that are the CONTRACTOR'S OWN papers: a
-- trade license, a certification, a registration number. Insurance and bond
-- policies are deliberately NOT stored here — they belong to the one home for
-- insurance across the platform (resident liability, building, vendor), and
-- storing a policy in two places guarantees the two disagree. The marketplace
-- reads the answer off contractors.insurance_verified / bond_verified.
--
-- Privacy: a credential is the contractor's own document. It is visible to the
-- contractor, to GAM, and to a landlord ONLY on a job that contractor has bid
-- on — a landlord deciding whether to let someone onto their park has a reason
-- to see the paper; a landlord idly browsing does not. Enforced per row at the
-- serve endpoint, which is the recurring bug class in this codebase.
--
-- Files follow the business-attachments pattern: bytes on disk under a
-- uuid-renamed filename, never served statically, never reachable without a
-- login.
--
-- No backfill needed: new table.

CREATE TABLE IF NOT EXISTS contractor_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id uuid NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  kind text NOT NULL,
  -- What it says on the paper.
  number text,
  issuer text,
  state text,
  issued_on date,
  expires_on date,
  -- The uploaded proof. Nullable: a contractor may record a license number
  -- before they find the PDF, and a number with no scan is still worth having.
  file_name text,
  stored_filename text,
  mime_type text,
  file_size_bytes integer,
  -- GAM confirmed the paper is what it claims to be. Never self-serve.
  verified_at timestamptz,
  verified_by_user_id uuid REFERENCES users(id),
  note text,
  uploaded_by_user_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

ALTER TABLE contractor_credentials DROP CONSTRAINT IF EXISTS contractor_credentials_kind_check;
ALTER TABLE contractor_credentials ADD CONSTRAINT contractor_credentials_kind_check
  CHECK (kind = ANY (ARRAY['license', 'certification', 'registration', 'other']));

-- A verified credential names who verified it.
ALTER TABLE contractor_credentials DROP CONSTRAINT IF EXISTS contractor_credentials_verified_together;
ALTER TABLE contractor_credentials ADD CONSTRAINT contractor_credentials_verified_together
  CHECK ((verified_at IS NULL) = (verified_by_user_id IS NULL));

-- A stored file names itself completely or not at all.
ALTER TABLE contractor_credentials DROP CONSTRAINT IF EXISTS contractor_credentials_file_together;
ALTER TABLE contractor_credentials ADD CONSTRAINT contractor_credentials_file_together
  CHECK ((stored_filename IS NULL AND file_name IS NULL)
      OR (stored_filename IS NOT NULL AND file_name IS NOT NULL));

CREATE INDEX IF NOT EXISTS ix_contractor_credentials_contractor
  ON contractor_credentials(contractor_id);
CREATE INDEX IF NOT EXISTS ix_contractor_credentials_expiring
  ON contractor_credentials(expires_on) WHERE expires_on IS NOT NULL;
