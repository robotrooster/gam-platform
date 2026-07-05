-- Per-property DEFAULT PRICING by unit type, with optional sub-type overrides.
-- Why: when a landlord adds a unit they pick a type (and sub-type: bedrooms for
-- residential, layout/amp for RV spots) and the pricing fields prefill from
-- these rows — type default first, sub-type override when one matches (S526,
-- Nic). These are CREATION-TIME defaults only: the unit stores its own copy,
-- and live booking pricing keeps its existing unit → property fallback chain.
--
-- subtype_key convention (see packages/shared resolveUnitTypePricing):
--   ''                      → the unit type's default row
--   'bed:<n>'               → bedroom-count override (apartment/single_family/mobile_home)
--   'rv:<layout>|<amp>'     → RV override; layout ∈ any|back_in|pull_through, amp ∈ any|30|50
--
-- No backfill needed (new feature; absence of rows = no prefill).
CREATE TABLE IF NOT EXISTS property_unit_type_pricing (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  property_id      uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  unit_type        text NOT NULL CHECK (unit_type = ANY (ARRAY['apartment','single_family','rv_spot','mobile_home','storage','commercial'])),
  subtype_key      text NOT NULL DEFAULT '',
  rent_amount      numeric(10,2),
  security_deposit numeric(10,2),
  nightly_rate     numeric(10,2),
  weekly_rate      numeric(10,2),
  monthly_rate     numeric(10,2),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, unit_type, subtype_key)
);

CREATE INDEX IF NOT EXISTS idx_putp_property ON property_unit_type_pricing(property_id);
