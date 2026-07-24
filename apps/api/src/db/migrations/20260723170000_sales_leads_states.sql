-- S553: sales_leads.states — which state(s) the prospect operates in.
--
-- Why: Nic's first-contact qualification set for the sales agent (Lucy) is
-- name+contact, state(s), rough unit count, and property mix — extracted
-- organically from conversation, never as a form. States materially change
-- the quote (screening caps, deposit rules, tax forms), so the team needs
-- it on the lead card before the Portfolio Specialist follow-up call.
-- Free text in the prospect's words ("Arizona and Utah"), consistent with
-- portfolio_size / property_type.
--
-- No backfill needed: existing leads simply have no recorded states.

ALTER TABLE sales_leads ADD COLUMN IF NOT EXISTS states text;
