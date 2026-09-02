-- S631 (Nic, DIRECTIVE): "When a landlord is in the onboarding window, any
-- invites should be automatically flagged as existing tenancies. It takes a
-- different path in the onboarding window, like that twenty-eight day grace
-- period that we added."
--
-- On the TABLE, not in the invite endpoints. There are four places that create
-- an intent today (two landlord invite paths, the bulk importer, the tenant-side
-- path) and the whole point of the rule is that nobody has to remember it — a
-- fifth path added next month inherits it, and so does the landlord agent.
--
-- The landlord's 28-day migration window is the one encoded here because it is a
-- pure function of landlords.created_at, so SQL and TypeScript cannot drift. The
-- per-property onboarding window (14 days + 1 per 10 units, capped at 30) is a
-- computed length that lives in services/onboardingWindow.ts; app code applies
-- that one on top via isExistingTenancyInvite(). This trigger only ever turns
-- the flag ON, so the two can never fight.
--
-- An explicit `true` from the caller is always honoured; only the DEFAULT false
-- is overridden. A landlord who marks a genuine new move-in keeps that answer.
CREATE OR REPLACE FUNCTION intent_default_existing_tenancy() RETURNS trigger AS $$
BEGIN
  IF NEW.is_existing_tenancy IS NOT TRUE THEN
    SELECT (now() < l.created_at + (28 * INTERVAL '1 day'))
      INTO NEW.is_existing_tenancy
      FROM landlords l WHERE l.id = NEW.landlord_id;
    NEW.is_existing_tenancy := COALESCE(NEW.is_existing_tenancy, false);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_intent_default_existing_tenancy ON pending_tenant_intents;
CREATE TRIGGER trg_intent_default_existing_tenancy
  BEFORE INSERT ON pending_tenant_intents
  FOR EACH ROW EXECUTE FUNCTION intent_default_existing_tenancy();
