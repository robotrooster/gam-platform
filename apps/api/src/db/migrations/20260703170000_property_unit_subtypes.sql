-- OWNER-DEFINED unit subtypes (S527, Nic directive) — replaces the S526
-- pre-baked subtype_key model (property_unit_type_pricing).
--
-- Why: subtypes must start BLANK for every landlord and contain only what
-- they create ("if a landlord only has studios they don't need to see 1 or
-- 2"). A subtype is the owner's own named class of unit ("Studio",
-- "Riverfront pull-through", "10x10") carrying the facts that matter for its
-- unit type (bedrooms/bathrooms for residential, layout/amp for RV, size for
-- storage) plus creation-time pricing. Add Unit picks one of the property's
-- subtypes and everything prefills; the unit stores its own copy (unit copy
-- stays authoritative, same posture as S526).
--
-- Backfill: the existing property_unit_type_pricing rows (demo data only —
-- shipped 2026-07-02) are converted to named subtypes below, with the old
-- field-level default→override merge applied at conversion time so a
-- standalone subtype keeps the effective pricing it had. The old table is
-- RETIRED IN PLACE (no reader after S527); a future migration drops it.
CREATE TABLE IF NOT EXISTS property_unit_subtypes (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  property_id      uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  unit_type        text NOT NULL CHECK (unit_type = ANY (ARRAY['apartment','single_family','rv_spot','mobile_home','storage','commercial'])),
  name             text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 60),
  -- Type-relevant facts — nullable; UI only surfaces the ones that apply.
  bedrooms         integer CHECK (bedrooms >= 0),
  bathrooms        numeric(3,1) CHECK (bathrooms >= 0),
  rv_site_layout   text CHECK (rv_site_layout = ANY (ARRAY['none','back_in','pull_through'])),
  rv_amp_service   text CHECK (rv_amp_service = ANY (ARRAY['none','30','50','both'])),
  storage_size     text,
  -- Creation-time pricing defaults (same five fields as the retired model).
  rent_amount      numeric(10,2),
  security_deposit numeric(10,2),
  nightly_rate     numeric(10,2),
  weekly_rate      numeric(10,2),
  monthly_rate     numeric(10,2),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, unit_type, name)
);

CREATE INDEX IF NOT EXISTS idx_pus_property ON property_unit_subtypes(property_id);

-- Units remember which owner subtype they were created from (nullable —
-- manual units have none; deleting a subtype keeps its units).
ALTER TABLE units ADD COLUMN IF NOT EXISTS subtype_id uuid REFERENCES property_unit_subtypes(id) ON DELETE SET NULL;

-- ── Convert existing pricing rows to named subtypes ────────────────────
-- Effective pricing = COALESCE(override field, that type's '' default field)
-- (replicates shared resolveUnitTypePricing's field-level merge). Names:
--   ''            → 'Standard'
--   bed:0         → 'Studio' | bed:<n> → '<n> bedroom(s)'
--   rv:<l>|<a>    → 'Pull-through · 50 amp' style label
--   size:<v>      → '<v>'
INSERT INTO property_unit_subtypes
  (property_id, unit_type, name, bedrooms, rv_site_layout, rv_amp_service, storage_size,
   rent_amount, security_deposit, nightly_rate, weekly_rate, monthly_rate)
SELECT
  o.property_id,
  o.unit_type,
  CASE
    WHEN o.subtype_key = ''            THEN 'Standard'
    WHEN o.subtype_key = 'bed:0'       THEN 'Studio'
    WHEN o.subtype_key LIKE 'bed:%'    THEN substring(o.subtype_key from 5) || ' bedroom' ||
                                            CASE WHEN substring(o.subtype_key from 5) = '1' THEN '' ELSE 's' END
    WHEN o.subtype_key LIKE 'size:%'   THEN substring(o.subtype_key from 6)
    WHEN o.subtype_key LIKE 'rv:%'     THEN trim(BOTH ' ·' FROM
      concat_ws(' · ',
        CASE split_part(substring(o.subtype_key from 4), '|', 1)
          WHEN 'pull_through' THEN 'Pull-through'
          WHEN 'back_in'      THEN 'Back-in'
          ELSE NULL END,
        CASE WHEN split_part(substring(o.subtype_key from 4), '|', 2) IN ('30','50')
          THEN split_part(substring(o.subtype_key from 4), '|', 2) || ' amp'
          ELSE NULL END))
    ELSE o.subtype_key
  END,
  CASE WHEN o.subtype_key LIKE 'bed:%' THEN substring(o.subtype_key from 5)::int END,
  CASE WHEN o.subtype_key LIKE 'rv:%' AND split_part(substring(o.subtype_key from 4), '|', 1) IN ('back_in','pull_through')
       THEN split_part(substring(o.subtype_key from 4), '|', 1) END,
  CASE WHEN o.subtype_key LIKE 'rv:%' AND split_part(substring(o.subtype_key from 4), '|', 2) IN ('30','50')
       THEN split_part(substring(o.subtype_key from 4), '|', 2) END,
  CASE WHEN o.subtype_key LIKE 'size:%' THEN substring(o.subtype_key from 6) END,
  COALESCE(o.rent_amount,      d.rent_amount),
  COALESCE(o.security_deposit, d.security_deposit),
  COALESCE(o.nightly_rate,     d.nightly_rate),
  COALESCE(o.weekly_rate,      d.weekly_rate),
  COALESCE(o.monthly_rate,     d.monthly_rate)
FROM property_unit_type_pricing o
LEFT JOIN property_unit_type_pricing d
  ON d.property_id = o.property_id AND d.unit_type = o.unit_type AND d.subtype_key = ''
 AND o.subtype_key <> ''
ON CONFLICT (property_id, unit_type, name) DO NOTHING;
