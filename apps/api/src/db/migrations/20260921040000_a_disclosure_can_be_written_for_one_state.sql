-- S652: many disclosures per category, because many of these forms are a state's
-- own words and not a landlord's.
--
-- Nic: "are any of these forms state specific or could I use one asbestos
-- disclosure for all seventeen states that require an asbestos disclosure...
-- when the form is specific we need to be able to assign multiple per category."
--
-- Both cases are real, which is why one column cannot be skipped:
--
--   FEDERAL, so one form everywhere. Lead-based paint is 42 U.S.C. 4852d — the
--   same disclosure in all fifty states. (And its sale-versus-lease split is
--   that federal rule, not Illinois being redundant: a sale must offer a ten-day
--   inspection opportunity that a lease does not. Blu's two forms are correct.)
--
--   STATE-PRESCRIBED, so one per state. Washington legislates the FORMAT of the
--   disclosure statement, separately for improved, unimproved and commercial
--   property; Minnesota, Michigan, Ohio and Nebraska each prescribe their own.
--   One asbestos form does not serve seventeen states.
--
--   NEITHER, where a statute says only "disclose what you know" and the
--   landlord's own notice travels anywhere.
--
-- NULL means the form is not written for any particular state, which covers the
-- federal and the generic cases together — and is the right default, because a
-- landlord who has not thought about states should not be asked to.
--
-- Resolution is most-specific-wins: a form written for this property's state
-- beats a general one. No claim is made that the state form is REQUIRED; it is
-- simply the one the landlord filed for that state.

ALTER TABLE lease_templates
  ADD COLUMN IF NOT EXISTS state_code TEXT;

COMMENT ON COLUMN lease_templates.state_code IS
  'S652: the state this form was written for. NULL = any state (federal forms like lead-based paint, and landlord-written notices). Most-specific-wins when a packet picks between them.';

CREATE INDEX IF NOT EXISTS lease_templates_disclosure_state_idx
  ON lease_templates (landlord_id, disclosure_type, state_code)
  WHERE disclosure_type IS NOT NULL;
