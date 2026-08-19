-- S604 (Nic): per-state deposit CUSTODY rules — where the cash may physically sit.
--
-- Distinct from state_deposit_interest_rates, which says what must be PAID.
-- This says where the principal may be HELD, and that constrains the vehicle:
-- GAM's plan is Treasury bills via Jiko, but a brokerage-held T-bill is not a
-- "federally insured depository institution" account, and several states require
-- exactly that — some further requiring the institution be IN-STATE.
--
-- Florida § 83.49 is the worked example: deposits must sit in a "Florida
-- financial institution", and the landlord may not "hypothecate, pledge, or in
-- any other way make use of" them. T-bills do not satisfy that. A Florida
-- landlord therefore cannot be onboarded onto GAM custody until an alternative
-- vehicle exists for that state.
--
-- Maryland § 8-203 is the opposite: it expressly permits insured CDs AND
-- "securities issued by the federal government", so T-bills are fine there.
--
-- OPERATING RULE (Nic): the moment a landlord from a not-yet-supported state
-- tries to onboard, that becomes an IMMEDIATE build — not a backlog item. The
-- flag is emitted by services/depositCustody.ts on property create.
--
-- custody_status:
--   'supported'      — GAM's current vehicle (T-bills) is lawful here
--   'needs_research' — a depository/in-state/other restriction is on the books;
--                      an alternative vehicle must be sourced before onboarding
--   'blocked'        — positively verified that the current vehicle is unlawful
--
-- Unlisted states default to 'needs_research' at READ time (see the resolver),
-- deliberately fail-closed: silence in this table means "not yet researched",
-- never "go ahead".

CREATE TABLE IF NOT EXISTS state_deposit_custody_rules (
  state_code                    text        NOT NULL,
  custody_status                text        NOT NULL,
  allows_treasury_bills         boolean     NOT NULL DEFAULT false,
  requires_in_state_depository  boolean     NOT NULL DEFAULT false,
  requires_federally_insured    boolean     NOT NULL DEFAULT false,
  requires_interest_bearing     boolean     NOT NULL DEFAULT false,
  prohibits_use_of_funds        boolean     NOT NULL DEFAULT false,
  statute_citation              text,
  notes                         text,
  researched_at                 date,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (state_code),
  CONSTRAINT sdcr_state_check  CHECK (state_code = upper(state_code) AND length(state_code) = 2),
  CONSTRAINT sdcr_status_check CHECK (custody_status IN ('supported', 'needs_research', 'blocked'))
);

COMMENT ON TABLE state_deposit_custody_rules IS
  'S604: where deposit principal may lawfully be held, per state. Constrains the custody VEHICLE (T-bills vs insured depository). Fail-closed: an absent state reads as needs_research.';
COMMENT ON COLUMN state_deposit_custody_rules.prohibits_use_of_funds IS
  'Statute bars hypothecating/pledging/otherwise using the funds (e.g. FL 83.49) — rules out investing the principal regardless of institution.';

-- ── Seeded from the 50-state corpus (state_law_section_texts) ─────────────
-- Only rows below were actually READ. Everything else stays unlisted and
-- therefore needs_research — do not bulk-insert optimistic 'supported' rows.

-- Positively verified: federal securities expressly permitted.
INSERT INTO state_deposit_custody_rules
  (state_code, custody_status, allows_treasury_bills, requires_in_state_depository,
   requires_federally_insured, statute_citation, notes, researched_at)
VALUES
  ('MD', 'supported', true, true, true, 'Md. Code, Real Prop. § 8-203',
   'Expressly permits insured CDs at in-state branches OR "securities issued by the federal government or the State of Maryland". T-bills lawful.',
   '2026-08-14')
ON CONFLICT (state_code) DO NOTHING;

-- Positively verified: in-state depository required AND use of funds barred.
INSERT INTO state_deposit_custody_rules
  (state_code, custody_status, allows_treasury_bills, requires_in_state_depository,
   requires_federally_insured, requires_interest_bearing, prohibits_use_of_funds,
   statute_citation, notes, researched_at)
VALUES
  ('FL', 'blocked', false, true, false, true, true, 'Fla. Stat. § 83.49',
   'Requires a "Florida financial institution" and bars hypothecating, pledging or otherwise making use of the funds. Brokerage-held T-bills do not qualify. Needs an in-state depository product before any FL onboarding.',
   '2026-08-14')
ON CONFLICT (state_code) DO NOTHING;

-- Depository / in-state / trust-account language found in the corpus. Marked
-- needs_research rather than blocked: the language is on the books but the
-- section has not been read closely enough to say the vehicle is unlawful.
INSERT INTO state_deposit_custody_rules
  (state_code, custody_status, allows_treasury_bills, requires_in_state_depository,
   requires_federally_insured, notes, researched_at)
SELECT s, 'needs_research', false,
       s IN ('CT','DE','GA','IL','MI','NC','NM','NY','OH','WA','WV'),
       true,
       'Corpus shows trust-account / federally-insured / in-state depository language touching deposits. Section not yet read in full — resolve before onboarding this state.',
       '2026-08-14'
FROM unnest(ARRAY[
  'AK','CO','CT','DE','GA','IA','ID','IL','KS','ME','MI','NC','ND','NM','NV',
  'NY','OH','OK','PA','VA','WA','WV'
]) AS s
ON CONFLICT (state_code) DO NOTHING;

-- Interest-bearing-account mandates (distinct from a rate obligation: the
-- ACCOUNT must bear interest, which a non-interest demand account fails).
UPDATE state_deposit_custody_rules
   SET requires_interest_bearing = true, updated_at = now()
 WHERE state_code IN ('CA','FL','IA','KS','MA','ND','NY','PA');

-- MA/CA aren't in the depository list above but do carry interest-bearing
-- mandates, so they need their own rows.
INSERT INTO state_deposit_custody_rules
  (state_code, custody_status, allows_treasury_bills, requires_interest_bearing,
   statute_citation, notes, researched_at)
VALUES
  ('MA', 'needs_research', false, true, 'Mass. G.L. c. 186 § 15B',
   'Interest is "5% or such lesser amount as has been received from the bank where the deposit has been held" — the lesser-of basis implies a BANK account, which a brokerage T-bill position is not. Verify before onboarding.',
   '2026-08-14'),
  ('CA', 'needs_research', false, true, NULL,
   'Interest-bearing language present in the corpus; section not yet read in full.',
   '2026-08-14')
ON CONFLICT (state_code) DO NOTHING;
