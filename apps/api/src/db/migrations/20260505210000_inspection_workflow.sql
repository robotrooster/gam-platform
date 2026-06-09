-- Inspection workflow: schema for move-in / move-out / periodic
-- inspections with checklist items, photo evidence, and dual-party
-- sign-off. Drives the credit-ledger events
--   move_in_inspection_completed
--   move_out_inspection_completed
--   move_out_condition_matches_move_in
--   move_out_condition_damage_documented
--   move_in_photos_submitted
--   move_out_photos_submitted
--
-- whose scoring values were already seeded in the v1.0.0 formula.
--
-- Move-out condition_matches comparison: the move-out finalize handler
-- walks each item, looks for the matching (area, item_label) item in
-- the comparison move-in inspection, and decides matches-vs-damage.
-- Comparison pointer is stored on the move-out row so the relationship
-- is explicit rather than inferred.
--
-- No backfill needed: pre-launch volume zero.

CREATE TABLE unit_inspections (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id                     UUID NOT NULL REFERENCES units(id),
  lease_id                    UUID REFERENCES leases(id),
  tenant_id                   UUID REFERENCES tenants(id),
  landlord_id                 UUID NOT NULL REFERENCES landlords(id),
  inspection_type             TEXT NOT NULL CHECK (inspection_type IN ('move_in', 'move_out', 'periodic')),
  status                      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft',
    'tenant_signed',
    'landlord_signed',
    'finalized',
    'disputed',
    'cancelled'
  )),
  comparison_inspection_id    UUID REFERENCES unit_inspections(id),
  scheduled_for               TIMESTAMPTZ,
  conducted_at                TIMESTAMPTZ,
  conducted_by_user_id        UUID REFERENCES users(id),
  finalized_at                TIMESTAMPTZ,
  notes                       TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_unit_inspections_unit    ON unit_inspections (unit_id);
CREATE INDEX idx_unit_inspections_lease   ON unit_inspections (lease_id);
CREATE INDEX idx_unit_inspections_tenant  ON unit_inspections (tenant_id);
CREATE INDEX idx_unit_inspections_status  ON unit_inspections (status);

CREATE TABLE unit_inspection_items (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_id          UUID NOT NULL REFERENCES unit_inspections(id) ON DELETE CASCADE,
  area                   TEXT NOT NULL,
  item_label             TEXT NOT NULL,
  condition              TEXT NOT NULL CHECK (condition IN ('good', 'fair', 'damaged', 'missing', 'na')),
  notes                  TEXT,
  estimated_repair_cost  NUMERIC(10,2),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (inspection_id, area, item_label)
);

CREATE INDEX idx_unit_inspection_items_inspection ON unit_inspection_items (inspection_id);
CREATE INDEX idx_unit_inspection_items_condition  ON unit_inspection_items (condition);

CREATE TABLE unit_inspection_photos (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_id   UUID NOT NULL REFERENCES unit_inspections(id) ON DELETE CASCADE,
  item_id         UUID REFERENCES unit_inspection_items(id) ON DELETE SET NULL,
  photo_url       TEXT NOT NULL,
  caption         TEXT,
  uploaded_by     UUID NOT NULL REFERENCES users(id),
  uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_unit_inspection_photos_inspection ON unit_inspection_photos (inspection_id);
CREATE INDEX idx_unit_inspection_photos_item       ON unit_inspection_photos (item_id);

CREATE TABLE unit_inspection_signatures (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_id        UUID NOT NULL REFERENCES unit_inspections(id) ON DELETE CASCADE,
  signer_user_id       UUID NOT NULL REFERENCES users(id),
  signer_role          TEXT NOT NULL CHECK (signer_role IN ('tenant', 'landlord', 'inspector')),
  signed_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  signature_evidence   JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (inspection_id, signer_user_id, signer_role)
);

CREATE INDEX idx_unit_inspection_signatures_inspection ON unit_inspection_signatures (inspection_id);
