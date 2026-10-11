-- S655 money plan M12 (Step 1). Expand-only: two partial unique indexes.
-- Production has no duplicates (10/2: 19 intents across 19 remittances; 1
-- remittance-funded paid-ahead credit).
--
-- Orphan-success safety: when a success webhook finds no remittance for an
-- intent it rebuilds one from the intent's metadata, and any money no row took
-- becomes paid-ahead money. One remittance per intent and one paid-ahead credit
-- per remittance make a replayed webhook land on the same rows instead of
-- writing the money twice.
CREATE UNIQUE INDEX IF NOT EXISTS ux_tenant_remittances_intent
  ON tenant_remittances (stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_lease_prepaid_credits_source_remittance
  ON lease_prepaid_credits (source_remittance_id) WHERE source_remittance_id IS NOT NULL;
