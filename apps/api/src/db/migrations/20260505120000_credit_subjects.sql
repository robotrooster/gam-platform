-- Credit Ledger v1: subjects table.
--
-- Polymorphic root for any entity with a credit ledger. A subject is the
-- owning identity of a hash-chain of events. Tenants, landlords, managers,
-- and properties are all valid subject types — slumlord history follows
-- the property even when ownership changes, so property has its own chain
-- distinct from any landlord's.
--
-- subject_ref_id points into the canonical table for that subject_type
-- (tenant -> users.id, landlord -> users.id with role=landlord,
-- manager -> users.id with one of the manager roles, property -> properties.id).
-- We don't FK it because subject_type drives the target table and Postgres
-- can't express a polymorphic FK cleanly. The (subject_type, subject_ref_id)
-- unique index prevents duplicate subjects for the same underlying entity.
--
-- No backfill needed: rows materialize lazily via appendEvent() the first
-- time an event lands for a given (type, ref_id).

CREATE TABLE credit_subjects (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type    TEXT NOT NULL CHECK (subject_type IN ('tenant', 'landlord', 'manager', 'property')),
  subject_ref_id  UUID NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (subject_type, subject_ref_id)
);

CREATE INDEX idx_credit_subjects_ref ON credit_subjects (subject_type, subject_ref_id);
