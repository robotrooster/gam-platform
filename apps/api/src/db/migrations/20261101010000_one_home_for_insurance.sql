-- 11/01 — ONE HOME FOR INSURANCE, FOR ALL THREE KINDS.
--
-- WHAT WAS THERE. `liability_insurance_policies` — a lease-keyed table with
-- carrier, policy number, expiry and a document url. ZERO rows since it was
-- created in the initial schema, with exactly one writer in the whole codebase
-- (jobs/leaseParser/resolveIntent.ts, which files what it finds on a scanned
-- lease) and no reader anywhere: no route, no job, no screen. So a policy the
-- parser lifted off a lease went into a table nobody ever looked at.
--
-- And it only ever covered the RESIDENT. A vendor's or contractor's general
-- liability and bond had nowhere to live at all, and neither did the landlord's
-- own building policy — the one piece of paper a lender asks for. Nothing
-- anywhere told anybody a policy had expired, which is the only thing insurance
-- records are actually for: a certificate on file that lapsed three months ago
-- is worse than no certificate, because the operator thinks they are covered.
--
-- ── ONE TABLE, NOT THREE ────────────────────────────────────────────────────
--
-- Every policy carries the identical set of facts — carrier, policy number,
-- coverage amount, the day it starts, the day it ends, the certificate somebody
-- uploaded, who recorded it, and whether a person has checked it. There is not
-- one column that belongs to a building policy and not to a vendor's. Three
-- tables would be the same columns written three times.
--
-- The lapse list settles it. "What has expired or expires soon" is the whole
-- point of the subsystem, and across three tables it is a three-way UNION that
-- has to be kept in step forever — the exact shape that goes stale the first
-- time a fourth kind of policy is added and one query is missed. Here it is one
-- WHERE clause.
--
-- The authorization settles it twice over. Reading another landlord's policy, or
-- another landlord's uploaded certificate, is the recurring bug class in this
-- codebase; three tables means three implementations of the same per-row check
-- and three chances to get it wrong. One table has one definition of "whose
-- policy is this" (services/insurancePolicies.ts), and one place to test.
--
-- ── THERE IS NO landlord_id COLUMN, AND THAT IS DELIBERATE ──────────────────
--
-- Ownership lives on the PROPERTY, never under an account ([[gam-account-is-
-- access-not-ownership]]). A building policy belongs to a property. A resident's
-- renters policy belongs to their lease. A vendor's general liability belongs to
-- the vendor. So the SUBJECT is what the row carries, and the company comes from
-- the subject every single time it is asked:
--
--   property_id   -> properties.landlord_id
--   lease_id      -> leases.landlord_id
--   vendor_id     -> books_vendors.landlord_id
--   contractor_id -> nobody's: a marketplace contractor's paper is their own
--
-- A denormalized landlord_id would be a second answer to that question, and a
-- second answer can disagree with the first — a property sold to another company
-- would leave every certificate on it still scoped to the seller. Deriving it
-- costs one join and cannot drift.
--
-- ── THE CONTRACTOR SUBJECT ──────────────────────────────────────────────────
--
-- 20261101000100_contractor_credentials.sql (same day, contractor marketplace)
-- says, correctly: "Insurance and bond policies are deliberately NOT stored here
-- — they belong to the one home for insurance across the platform... storing a
-- policy in two places guarantees the two disagree," and
-- `contractors.insurance_verified / insurance_expiry / bond_verified /
-- bond_expiry` are described there as "a projection of it rather than a second
-- place to type a policy." So contractor_id is a valid subject HERE, now, so
-- that promise has somewhere to land.
--
-- The landlord-side routes in this build cover the three kinds the operator
-- collects: a property's building policy, a resident's renters liability, and a
-- vendor's general liability and bond. A contractor-subject policy is the
-- marketplace's to write and its privacy rule is the marketplace's to enforce (a
-- landlord sees a contractor's paper only on a job that contractor bid on) —
-- routes/insurance.ts resolves no company for it, so a landlord asking for one
-- gets the same 404 as for a policy that does not exist.
--
-- ── WHAT IS NOT HERE ────────────────────────────────────────────────────────
--
-- No state-specific requirement, no minimum coverage amount, no "your state
-- requires X". GAM does not gate on legality and gives no legal advice; what an
-- operator requires of a resident or a vendor is theirs to decide and theirs to
-- type. coverage_amount is recorded, never checked against anything.
--
-- A policy is never erased, only voided with a reason ([[gam-data-retention-
-- keep-everything]]), because "there was a certificate on file and somebody took
-- it off" is exactly the fact a later argument turns on.
--
-- NO BACKFILL NEEDED: `liability_insurance_policies` holds zero rows on
-- production and in every environment checked. Its one writer is repointed in
-- this build; the table itself is left in place rather than dropped (forward-only
-- migrations, and a drop is a contract step that wants Nic's go-ahead).

CREATE TABLE IF NOT EXISTS insurance_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Exactly one subject. The company that may see this row is derived from it.
  property_id   uuid REFERENCES properties(id)     ON DELETE CASCADE,
  lease_id      uuid REFERENCES leases(id)         ON DELETE CASCADE,
  vendor_id     uuid REFERENCES books_vendors(id)  ON DELETE CASCADE,
  contractor_id uuid REFERENCES contractors(id)    ON DELETE CASCADE,

  -- What kind of cover this is. Classifies; it never prices anything
  -- ([[gam-subtypes-classify-never-price]]).
  coverage_type text NOT NULL,

  -- What it says on the certificate.
  carrier_name    text NOT NULL,
  policy_number   text,
  coverage_amount numeric(14,2),
  effective_date  date,
  expiry_date     date,

  -- The uploaded proof. Nullable the whole way: an operator who has the carrier
  -- and the expiry date off a phone call has something worth recording before
  -- the PDF arrives, and a recorded expiry date is what the lapse list reads.
  -- Bytes live under uploads/insurance/ with a generated filename and are never
  -- served statically — the serve route authorizes the POLICY row first
  -- ([[gam-nothing-public-rule]], [[gam-file-serve-perrow-auth]]).
  proof_file_name           text,
  proof_url                 text,
  proof_mime_type           text,
  proof_file_size_bytes     integer,
  proof_uploaded_at         timestamptz,
  proof_uploaded_by_user_id uuid REFERENCES users(id),

  -- Who recorded it, and who checked it. Two different acts by two possible
  -- people: typing what a certificate says is clerical, saying "I have read this
  -- certificate and it is what it claims" is somebody putting their name to it.
  recorded_by_user_id uuid REFERENCES users(id),
  verified_at         timestamptz,
  verified_by_user_id uuid REFERENCES users(id),

  notes text,

  -- Kept, never deleted.
  voided_at         timestamptz,
  voided_by_user_id uuid REFERENCES users(id),
  void_reason       text,

  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

-- A policy belongs to ONE thing. Not zero (a certificate about nothing is not a
-- record of anything), not two (two owners means two answers to "whose is it").
ALTER TABLE insurance_policies DROP CONSTRAINT IF EXISTS insurance_policies_one_subject;
ALTER TABLE insurance_policies ADD CONSTRAINT insurance_policies_one_subject
  CHECK (num_nonnulls(property_id, lease_id, vendor_id, contractor_id) = 1);

ALTER TABLE insurance_policies DROP CONSTRAINT IF EXISTS insurance_policies_coverage_type_check;
ALTER TABLE insurance_policies ADD CONSTRAINT insurance_policies_coverage_type_check
  CHECK (coverage_type = ANY (ARRAY[
    'building',           -- the landlord's own policy on the park or the building
    'general_liability',  -- premises liability (a property) or a vendor's GL
    'renters_liability',  -- the resident's renters / liability policy
    'surety_bond'         -- a vendor's or contractor's bond
  ]));

-- The pairing: a kind of cover that cannot belong to that kind of subject is a
-- typo, not a record. "Building policy" on a lease means somebody picked the
-- wrong row, and the database is the one place that catches it every time.
ALTER TABLE insurance_policies DROP CONSTRAINT IF EXISTS insurance_policies_coverage_fits_subject;
ALTER TABLE insurance_policies ADD CONSTRAINT insurance_policies_coverage_fits_subject
  CHECK (
       (property_id   IS NOT NULL AND coverage_type IN ('building', 'general_liability'))
    OR (lease_id      IS NOT NULL AND coverage_type = 'renters_liability')
    OR (vendor_id     IS NOT NULL AND coverage_type IN ('general_liability', 'surety_bond'))
    OR (contractor_id IS NOT NULL AND coverage_type IN ('general_liability', 'surety_bond'))
  );

-- A verified policy names who verified it. "Verified" with nobody's name on it
-- is the thing a later argument cannot use.
ALTER TABLE insurance_policies DROP CONSTRAINT IF EXISTS insurance_policies_verified_together;
ALTER TABLE insurance_policies ADD CONSTRAINT insurance_policies_verified_together
  CHECK ((verified_at IS NULL) = (verified_by_user_id IS NULL));

-- A stored file names itself completely or not at all, so a row can never point
-- at bytes it cannot describe.
ALTER TABLE insurance_policies DROP CONSTRAINT IF EXISTS insurance_policies_proof_together;
ALTER TABLE insurance_policies ADD CONSTRAINT insurance_policies_proof_together
  CHECK ((proof_url IS NULL AND proof_file_name IS NULL AND proof_uploaded_at IS NULL)
      OR (proof_url IS NOT NULL AND proof_file_name IS NOT NULL AND proof_uploaded_at IS NOT NULL));

-- Taking a certificate off the record is a decision with a reason attached.
ALTER TABLE insurance_policies DROP CONSTRAINT IF EXISTS insurance_policies_voided_together;
ALTER TABLE insurance_policies ADD CONSTRAINT insurance_policies_voided_together
  CHECK ((voided_at IS NULL AND voided_by_user_id IS NULL AND void_reason IS NULL)
      OR (voided_at IS NOT NULL AND voided_by_user_id IS NOT NULL AND btrim(void_reason) <> ''));

-- A policy that expires before it starts is a mistyped date, caught here rather
-- than silently landing on a lapse list that then reads as a crisis.
ALTER TABLE insurance_policies DROP CONSTRAINT IF EXISTS insurance_policies_dates_sane;
ALTER TABLE insurance_policies ADD CONSTRAINT insurance_policies_dates_sane
  CHECK (effective_date IS NULL OR expiry_date IS NULL OR expiry_date >= effective_date);

ALTER TABLE insurance_policies DROP CONSTRAINT IF EXISTS insurance_policies_coverage_amount_sane;
ALTER TABLE insurance_policies ADD CONSTRAINT insurance_policies_coverage_amount_sane
  CHECK (coverage_amount IS NULL OR coverage_amount >= 0);

-- Subject lookups: "show me this property's / this lease's / this vendor's
-- policies" is every read on the subsystem.
CREATE INDEX IF NOT EXISTS ix_insurance_policies_property
  ON insurance_policies (property_id) WHERE property_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_insurance_policies_lease
  ON insurance_policies (lease_id) WHERE lease_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_insurance_policies_vendor
  ON insurance_policies (vendor_id) WHERE vendor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_insurance_policies_contractor
  ON insurance_policies (contractor_id) WHERE contractor_id IS NOT NULL;

-- The lapse list. A voided policy and a policy with no end date are not lapses,
-- so they are not in the index either.
CREATE INDEX IF NOT EXISTS ix_insurance_policies_expiring
  ON insurance_policies (expiry_date)
  WHERE voided_at IS NULL AND expiry_date IS NOT NULL;

-- coverage_amount is money, so the change journal is the only record of what
-- this row said before somebody edited it, and it is never pruned.
DROP TRIGGER IF EXISTS audit_insurance_policies ON insurance_policies;
CREATE TRIGGER audit_insurance_policies
  AFTER UPDATE OR DELETE ON insurance_policies
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

DROP TRIGGER IF EXISTS trg_insurance_policies_updated_at ON insurance_policies;
CREATE TRIGGER trg_insurance_policies_updated_at
  BEFORE UPDATE ON insurance_policies
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE insurance_policies IS
  '11/01: the one home for insurance — a property''s building policy, a resident''s renters liability, a vendor''s or contractor''s general liability and bond. The SUBJECT carries the row; the company is derived from the subject and never stored, so a sold property cannot leave its certificates scoped to the seller.';
COMMENT ON COLUMN insurance_policies.coverage_amount IS
  '11/01: what the certificate says the limit is. Recorded, never checked against a minimum — GAM does not gate on legality and sets no coverage requirement.';
COMMENT ON COLUMN insurance_policies.proof_url IS
  '11/01: /uploads/insurance/<generated name>. Never served statically; the serve route authorizes the policy row first.';
COMMENT ON COLUMN insurance_policies.verified_at IS
  '11/01: a person has read the certificate and says it is what it claims. Separate from recorded_by: typing what a policy says is clerical, attesting to it is somebody putting their name on it.';

COMMENT ON TABLE liability_insurance_policies IS
  'SUPERSEDED 11/01 by insurance_policies, which covers all three kinds and has a lapse list. Zero rows; its one writer (jobs/leaseParser) was repointed. Left in place rather than dropped — GAM keeps everything, and a drop is a contract step.';
