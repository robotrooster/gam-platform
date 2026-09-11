-- S641 (Nic) — sign a PACKAGE, not a pile of unrelated documents.
--
--   "some things are pertinent to some tenants and some things are not, all at
--    the same property. So I wanna have a way to prepare a package for
--    signature where I click: the residential lease, the work trade agreement,
--    if they are in a mobile home it's the statement of policy for Arizona,
--    it's the park rules… a lot of people are gonna be like, well, I already
--    signed the lease, what's this for?"
--
-- Country Acres is the case that forced it: the current owner bundles a lot
-- lease and a rent-to-own contract into ONE five-year flat price, so nobody can
-- tell what was paid for the land and what was paid for the trailer. Splitting
-- them into two instruments is right, and it only works if the tenant signs
-- both in one sitting.

-- ── A package lives at the LANDLORD, and is bound to a unit type ────────────
--
-- Nic: "if I buy another RV park in Arizona where the rules are the same, my
-- Arizona RV package could be used at that other property as well. Whereas if
-- you have it locked at the property level and you have different unit types at
-- the same property, it may try to send somebody the wrong package for their
-- unit type."
CREATE TABLE IF NOT EXISTS document_packages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  landlord_id   uuid NOT NULL REFERENCES landlords(id) ON DELETE CASCADE,
  name          text NOT NULL,
  description   text,
  -- NULL means "any unit type" — a package the landlord picks by hand.
  -- Same vocabulary as lease_templates.unit_type; there is no unit_types table.
  unit_type     text CHECK (unit_type IS NULL OR unit_type IN (
                  'apartment','single_family','rv_spot','campsite','mobile_home',
                  'hotel_room','storage','parking','boat_slip','land_lot','commercial')),
  -- The one offered first when drafting for a unit of this type.
  is_default    boolean NOT NULL DEFAULT FALSE,
  archived_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_document_packages_landlord
  ON document_packages (landlord_id) WHERE archived_at IS NULL;

-- At most one default per landlord per unit type.
CREATE UNIQUE INDEX IF NOT EXISTS ux_document_packages_default
  ON document_packages (landlord_id, COALESCE(unit_type, ''))
  WHERE is_default AND archived_at IS NULL;

-- ── What is in it ──────────────────────────────────────────────────────────
--
-- Items are TEMPLATES. Nic: "you can select from your lease template
-- agreements… you can select multiple of those documents that already have
-- signing boxes and create them into a package."
--
-- A template belongs to as many packages as the landlord likes, and being used
-- in one never locks it out of another: "I should be able to reuse that
-- separate document… not locked because it's already in use in another package.
-- I don't wanna have to reupload every different document every time you need a
-- new package."
CREATE TABLE IF NOT EXISTS document_package_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id   uuid NOT NULL REFERENCES document_packages(id) ON DELETE CASCADE,
  template_id  uuid NOT NULL REFERENCES lease_templates(id) ON DELETE RESTRICT,
  sort_order   integer NOT NULL DEFAULT 0,

  -- What happens to this item when the lease renews. Decided per ITEM, because
  -- the answer genuinely differs inside one package:
  --
  --   with_lease        the lease itself, and anything whose term IS the lease
  --                     term. New term, new signature.
  --   once_per_tenancy  the installment contract, lead paint, a statement of
  --                     policy. Nic: "obviously they don't have to sign a new
  --                     contract for their installment loan." Re-executing a
  --                     five-year purchase contract because the lot lease
  --                     renewed muddies when the five years started.
  --   on_version_change park rules. Comes back only when the landlord has
  --                     published a version newer than the one this tenant
  --                     last agreed to — which also answers the mid-tenancy
  --                     change without a second mechanism.
  renewal_behavior text NOT NULL DEFAULT 'with_lease'
    CHECK (renewal_behavior IN ('with_lease', 'once_per_tenancy', 'on_version_change')),

  -- FALSE lets the landlord untick it on the draft screen for a tenant it does
  -- not apply to. Nic: "some things are pertinent to some tenants and some
  -- things are not, all at the same property."
  required     boolean NOT NULL DEFAULT FALSE,

  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (package_id, template_id)
);

CREATE INDEX IF NOT EXISTS idx_document_package_items_package
  ON document_package_items (package_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_document_package_items_template
  ON document_package_items (template_id);

-- ── Pinning a template to the properties it applies to ─────────────────────
--
-- Nic: "if I have parking rules at two of my properties and not at a third, I
-- don't wanna have to upload it two times… I wanna be able to pin it to
-- multiple properties and have it not go to the third."
--
-- NO ROWS means available everywhere — the statement of policy, lead paint, bed
-- bug disclosure. Rows mean "only these". Absence is the permissive default so
-- nothing that exists today changes behaviour.
CREATE TABLE IF NOT EXISTS lease_template_properties (
  template_id uuid NOT NULL REFERENCES lease_templates(id) ON DELETE CASCADE,
  property_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (template_id, property_id)
);

CREATE INDEX IF NOT EXISTS idx_lease_template_properties_property
  ON lease_template_properties (property_id);

-- ── A template has versions, so "has this changed?" is answerable ───────────
--
-- The on_version_change rule needs a fact, not a guess. Bumped whenever the
-- landlord replaces the PDF or moves the fields.
ALTER TABLE lease_templates
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;

-- What the signer actually agreed to. Without this, a re-issue decision has
-- nothing to compare against.
ALTER TABLE lease_documents
  ADD COLUMN IF NOT EXISTS template_version integer;

-- ── One tenant's assembled bundle ──────────────────────────────────────────
--
-- Deliberately NOT document_batches: that is the perpendicular relation — one
-- template out to many units. This is many templates to one signer.
--
-- A grouping id rather than another table: the bundle needs a shared identity
-- and an order, and nothing else that a row on the document cannot carry.
ALTER TABLE lease_documents
  ADD COLUMN IF NOT EXISTS package_group_id uuid;
ALTER TABLE lease_documents
  ADD COLUMN IF NOT EXISTS package_id uuid REFERENCES document_packages(id) ON DELETE SET NULL;
ALTER TABLE lease_documents
  ADD COLUMN IF NOT EXISTS package_sort_order integer;

CREATE INDEX IF NOT EXISTS idx_lease_documents_package_group
  ON lease_documents (package_group_id, package_sort_order)
  WHERE package_group_id IS NOT NULL;

-- ── Templates are more than leases now ─────────────────────────────────────
--
-- purpose allowed only 'lease' and 'work_trade_addendum', which is why Country
-- Acres' installment contract is currently typed as a LEASE. The package needs
-- to know what a thing is to order it and to default its renewal behaviour.
ALTER TABLE lease_templates
  DROP CONSTRAINT IF EXISTS lease_templates_purpose_check;
ALTER TABLE lease_templates
  ADD CONSTRAINT lease_templates_purpose_check
  CHECK (purpose IN (
    'lease',
    'work_trade_addendum',
    'installment_sale',   -- rent-to-own / owner financing, its own term
    'park_rules',
    'state_disclosure',   -- statement of policy, lead paint, bed bug
    'addendum',
    'other'
  ));
