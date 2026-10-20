-- 10/20 (Nic): TAKE THE STATE-LAW WARNINGS OFF THE PRODUCT.
--
-- "There should be no state law warnings anywhere in the system. At least not
-- right now. Just hide all that stuff."
--
-- This closes the question the 20261021170000 migration left open in writing.
-- That one put back the properties.late_fee_* columns and said the state-law
-- warning on the property page "should almost certainly read the per-unit-type
-- policy instead ... that is a behaviour change to a legal-adjacent check, so
-- it waits for him". It did not need repointing. It needed to stop showing.
--
-- He is right, and not only because he said so. GAM is a national platform
-- that gives no legal advice and no state-specific guidance (CLAUDE.md, "No
-- state-specific legal logic"), and it accommodates rather than blocks. A
-- banner telling a landlord their late fee sits above a Nevada figure is GAM
-- offering an opinion about a statute, which is the one thing that rule
-- forbids. On the property page it was toothless on top of that: it reads the
-- late-fee columns nothing writes, while the real policy lives in
-- property_unit_type_late_fees per unit type and is stamped onto the lease.
--
-- HIDDEN, NOT DELETED. "At least not right now" means it comes back, so
-- nothing is dropped: the sourced catalogs (state_landlord_tenant_acts,
-- state_law_provisions, state_law_section_texts) stay, the comparison engine
-- in services/stateLaw.ts stays with its tests, and the statute RETRIEVAL the
-- agents do when a person actually asks a question keeps working.
--
-- WHAT THIS ROW DOES: nothing by itself. services/systemFeatures closes by
-- default, so a missing flag already reads as OFF and the warnings are hidden
-- the moment the code ships. This row exists so the switch is VISIBLE and
-- flippable on the owner's system-features page instead of being a secret only
-- the code knows about. Turning the warnings back on is this one row set TRUE
-- — no deploy. Before anyone does, settle the per-unit-type question above.
--
-- NOT TOUCHED, on purpose: the S177 hard-compliance carve-outs. State deposit
-- interest (state_deposit_interest_rates) and the state tax-form catalog
-- (state_tax_forms) are obligations GAM accommodates so a landlord can comply,
-- not warnings GAM issues. Both keep running.
--
-- Expand-only and idempotent: one INSERT into system_features, no schema
-- change, safe to apply twice.
--
-- ON CONFLICT DOES NOT TOUCH `enabled`, and that is the point. This file first
-- said DO UPDATE SET enabled = FALSE, which contradicted the promise three
-- paragraphs up: gam_demo is migrated on its own and is currently behind
-- (latest 20261021170000), so someone turning the banners ON in demo to show
-- them would have had them switched back off by the next catch-up migrate,
-- silently, with no log line saying a deliberate setting was overwritten. The
-- row is SEEDED off and then belongs to whoever flips it. Only the description
-- is refreshed, so a reworded explanation still reaches a database that
-- already has the row.

INSERT INTO system_features (key, enabled, description)
VALUES (
  'state_law_warnings_enabled',
  FALSE,
  'State-law warning banners (the hedged "this is above/below the figure in <state> law" notices on the property pages, the lease and the entry request, the check_against_law agent tool, and the legal-adjacent cautions three tenant/landlord agent tools used to add on their own: get_my_landlord_patterns, draft_tenant_notice and get_my_entry_requests). HIDDEN 10/20 by Nic: "There should be no state law warnings anywhere in the system. At least not right now." OFF = no warning is computed or returned anywhere; the statute catalogs, the comparison engine and the agents'' statute retrieval all stay intact. ON = the banners and the agent cautions come back with no code change; the check_against_law agent tool needs one more line, because it is hidden from the model in services/agents/profiles.ts (LAW_TOOLS) rather than merely refusing - a tool a model can see is a tool it offers. Does NOT affect state deposit-interest rates or the state tax-form catalog (S177 hard-compliance carve-out).'
)
ON CONFLICT (key) DO UPDATE
  SET description = EXCLUDED.description;
