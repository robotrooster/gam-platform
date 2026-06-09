-- S108: PM (third-party property-management) companies — schema only.
--
-- This migration creates the three core tables (pm_companies, pm_staff,
-- pm_fee_plans) plus the per-property pointers (properties.pm_company_id,
-- properties.pm_fee_plan_id). NO routes, NO allocation-engine wire-up,
-- NO notification path — those land in S109+ once the schema is
-- battle-tested.
--
-- Distinction from in-house property managers:
--   property_manager_scopes  = OWNER's individual employees (already built S80)
--   pm_companies / pm_staff  = THIRD-PARTY management orgs (this migration)
-- The two coexist. A landlord can self-manage some properties via in-house
-- PMs and contract pm_companies for others.
--
-- Architecture:
--   - pm_companies is a top-level entity (org-level), independent of any
--     specific landlord. The same pm_company can manage properties for
--     many different landlords.
--   - pm_staff: one row per (pm_company, user) employment relationship.
--     A user can be staff at multiple pm_companies (consultants, etc.).
--   - pm_fee_plans: per-pm_company templates the company offers landlords.
--     One landlord might be on the "Standard 8%" plan, another on a
--     "Single-family flat $200" plan from the same pm_company.
--   - properties.pm_company_id + pm_fee_plan_id: per-property assignment.
--     One owner can self-manage some, contract pm_company A on plan X for
--     others, contract pm_company B on plan Y for the rest. Per-property
--     grain matches the existing 16a properties.managed_by_user_id grain.
--
-- Bank account routing: pm_companies.bank_account_id references
-- user_bank_accounts.id — keeps the 16a invariant that all bank accounts
-- are user-owned (the PM org's owner-user adds the company's bank in their
-- personal banking flow, then assigns it to the pm_company).

CREATE TABLE pm_companies (
    id                 uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    name               text NOT NULL,
    business_email     text,
    business_phone     text,
    business_street1   text,
    business_city      text,
    business_state     text,
    business_zip       text,
    ein                text,                          -- 1099 reporting
    bank_account_id    uuid REFERENCES user_bank_accounts(id) ON DELETE SET NULL,
    status             text NOT NULL DEFAULT 'active',
    created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at         timestamp with time zone NOT NULL DEFAULT now(),
    updated_at         timestamp with time zone NOT NULL DEFAULT now(),

    CONSTRAINT pm_companies_status_check
      CHECK (status = ANY (ARRAY['active', 'inactive', 'suspended']))
);

CREATE INDEX idx_pm_companies_status ON pm_companies(status);
CREATE INDEX idx_pm_companies_created_by ON pm_companies(created_by_user_id) WHERE created_by_user_id IS NOT NULL;


CREATE TABLE pm_staff (
    id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    pm_company_id       uuid NOT NULL REFERENCES pm_companies(id) ON DELETE CASCADE,
    user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role                text NOT NULL DEFAULT 'staff',
    permissions         jsonb NOT NULL DEFAULT '{}'::jsonb,
    status              text NOT NULL DEFAULT 'active',
    invited_by_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
    joined_at           timestamp with time zone,
    removed_at          timestamp with time zone,
    created_at          timestamp with time zone NOT NULL DEFAULT now(),
    updated_at          timestamp with time zone NOT NULL DEFAULT now(),

    CONSTRAINT pm_staff_role_check
      CHECK (role = ANY (ARRAY['owner', 'manager', 'staff'])),
    CONSTRAINT pm_staff_status_check
      CHECK (status = ANY (ARRAY['active', 'inactive', 'removed'])),
    CONSTRAINT pm_staff_unique_membership
      UNIQUE (pm_company_id, user_id)
);

CREATE INDEX idx_pm_staff_company_status ON pm_staff(pm_company_id, status);
CREATE INDEX idx_pm_staff_user_status    ON pm_staff(user_id, status);


CREATE TABLE pm_fee_plans (
    id                       uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    pm_company_id            uuid NOT NULL REFERENCES pm_companies(id) ON DELETE CASCADE,
    name                     text NOT NULL,
    fee_type                 text NOT NULL,
    -- Field set varies by fee_type. Application layer enforces which fields
    -- are required for which type; the DB allows nulls for any combo so
    -- composite plans (e.g. percent_with_floor needs both percent +
    -- floor_amount; per_unit + leasing_fee on same plan needs both) are
    -- expressible without an explosion of partial CHECKs. Future
    -- migration can add tighter per-type CHECKs once usage stabilizes.
    percent                  numeric(5,2),  -- 0–100
    flat_amount              numeric(10,2),
    floor_amount             numeric(10,2),
    ceiling_amount           numeric(10,2),
    leasing_fee_amount       numeric(10,2),
    maintenance_markup_pct   numeric(5,2),
    status                   text NOT NULL DEFAULT 'active',
    created_at               timestamp with time zone NOT NULL DEFAULT now(),
    updated_at               timestamp with time zone NOT NULL DEFAULT now(),

    CONSTRAINT pm_fee_plans_fee_type_check
      CHECK (fee_type = ANY (ARRAY[
        'percent_of_rent',
        'flat_monthly',
        'percent_with_floor',
        'percent_with_ceiling',
        'per_unit',
        'leasing_fee',
        'maintenance_markup_pct'
      ])),
    CONSTRAINT pm_fee_plans_status_check
      CHECK (status = ANY (ARRAY['active', 'inactive', 'deprecated'])),
    CONSTRAINT pm_fee_plans_percent_range
      CHECK (percent IS NULL OR (percent >= 0 AND percent <= 100)),
    CONSTRAINT pm_fee_plans_markup_range
      CHECK (maintenance_markup_pct IS NULL OR (maintenance_markup_pct >= 0 AND maintenance_markup_pct <= 100)),
    CONSTRAINT pm_fee_plans_floor_ceiling
      CHECK (floor_amount IS NULL OR ceiling_amount IS NULL OR floor_amount <= ceiling_amount)
);

CREATE INDEX idx_pm_fee_plans_company_status ON pm_fee_plans(pm_company_id, status);


-- Per-property assignment. Both nullable (nullable means the owner self-
-- manages this property, no PM company involved). The fee plan FK is set
-- separately so a property can technically have a pm_company without a
-- plan during onboarding (S109 will enforce that an active engagement
-- requires both).
ALTER TABLE properties
  ADD COLUMN pm_company_id  uuid REFERENCES pm_companies(id) ON DELETE SET NULL,
  ADD COLUMN pm_fee_plan_id uuid REFERENCES pm_fee_plans(id) ON DELETE SET NULL;

CREATE INDEX idx_properties_pm_company ON properties(pm_company_id) WHERE pm_company_id IS NOT NULL;

-- Cross-table sanity: if pm_fee_plan_id is set, it must belong to the
-- pm_company_id on the same property. This is a soft invariant — easier
-- to enforce in application code than a CHECK with cross-table lookup.
-- Documented here for future-Claude reading the migration: when S109
-- wires the assignment endpoint, the route MUST verify that the
-- selected fee_plan's pm_company_id matches the property's pm_company_id.
