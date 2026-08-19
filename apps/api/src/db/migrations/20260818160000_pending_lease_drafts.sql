-- S605 (Nic): remember which unit a tenant was invited to, so the lease can be
-- drafted later.
--
-- "We need to fix that flow so that if somebody does forget to add the template
-- first, at least have something to remember which unit the tenant was invited
-- to, so that when they add it, it refires."
--
-- The invite creates a user + a tenants row and NOTHING ELSE — it resolves the
-- landlord from the unit and then discards the unit. So a landlord who invited
-- before configuring a lease template had no path back: nothing recorded who was
-- waiting, or for which unit, and the auto-draft could never catch up.
--
-- This is the missing memory. One row per invited resident, holding the unit and
-- their place in the household (0 = primary, who holds the lease). When a
-- template is later set as the default for that unit type, every unresolved row
-- on a matching unit is drafted, and marked resolved.
--
-- Deliberately NOT reusing pending_tenant_intents: that table drives the
-- screening/background-check flow for PROPERTY-level applicants and explicitly
-- carries no unit, and the unit-bound invite path skips it on purpose to avoid
-- double-drafting. Overloading it would entangle two unrelated lifecycles.
--
-- Rows are resolved, never deleted — the retention rule, and it also keeps the
-- draft idempotent: an already-resolved row can't produce a second lease.
--
-- No backfill: nothing recorded this before, so there is nothing to recover.

CREATE TABLE IF NOT EXISTS pending_lease_drafts (
  id              uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
  landlord_id     uuid NOT NULL REFERENCES landlords(id) ON DELETE CASCADE,
  unit_id         uuid NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  tenant_user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 0 = primary resident (holds the lease); 1+ = co-tenants, in invite order.
  household_order integer NOT NULL DEFAULT 0,
  resolved_at     timestamptz,
  resolved_document_id uuid REFERENCES lease_documents(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (unit_id, tenant_user_id)
);

-- The "what is still waiting" lookup, run whenever a template becomes a default.
CREATE INDEX IF NOT EXISTS idx_pending_lease_drafts_open
  ON pending_lease_drafts (unit_id, household_order) WHERE resolved_at IS NULL;

COMMENT ON TABLE pending_lease_drafts IS
  'S605: tenants invited to a unit whose lease has not been drafted yet — usually because the unit type had no default lease template at invite time. Drafting is retried when one is set.';
