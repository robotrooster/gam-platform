-- S604 (Nic): "does 'financial institution' mean a physical location in that
-- state, or just licensed to operate there?" It depends entirely on the state —
-- the statutes use four materially different tests, and the first pass flattened
-- them all to "blocked", which was not useful and in Georgia's case was wrong
-- (flagged in-state when the statute expressly accepts ANY federally regulated
-- institution).
--
-- Two new columns make the distinction queryable, so the Jiko question can be
-- answered per state instead of per hunch:
--
--   institution_test — the verbatim requirement, quoted.
--   geography_test   — how much presence the institution needs:
--     'none'            no geographic requirement at all. Any federally
--                       regulated/insured institution qualifies. If Jiko's bank
--                       is nationally chartered, these turn on the ACCOUNT-TYPE
--                       question alone.
--     'doing_business'  institution must be authorised to do business in-state —
--                       a licensing test, which a 50-state-licensed provider
--                       plausibly meets.
--     'physical_office' institution must be LOCATED in / have an office in the
--                       state. Licensing alone does not satisfy this.
--     'state_chartered' institution must be organised under that state's own
--                       laws. The strictest; a national charter fails.
--     'n/a'             no institution requirement; blocked for another reason.
--
-- IMPORTANT — geography is only HALF the test. Every one of these states also
-- requires the money to sit in a deposit/escrow/trust ACCOUNT at that
-- institution. Whether Treasury bills held through a broker-dealer constitute
-- such an account is a separate question this table does NOT answer, and it is
-- the one that actually governs. A 'none' geography_test means the state is
-- worth pursuing, not that it is already cleared.

ALTER TABLE state_deposit_custody_rules
  ADD COLUMN IF NOT EXISTS institution_test text,
  ADD COLUMN IF NOT EXISTS geography_test   text;

ALTER TABLE state_deposit_custody_rules DROP CONSTRAINT IF EXISTS sdcr_geography_check;
ALTER TABLE state_deposit_custody_rules
  ADD CONSTRAINT sdcr_geography_check CHECK (
    geography_test IS NULL OR geography_test IN
      ('none','doing_business','physical_office','state_chartered','n/a'));

COMMENT ON COLUMN state_deposit_custody_rules.geography_test IS
  'S604: how much in-state presence the institution needs. none < doing_business < physical_office < state_chartered. Only half the test — the account-TYPE question is separate.';

-- ── geography_test = 'none' — any federally regulated institution ────────
UPDATE state_deposit_custody_rules SET geography_test='none', requires_in_state_depository=false,
  institution_test='"any bank or lending institution subject to regulation by this state OR ANY AGENCY OF THE UNITED STATES GOVERNMENT" — no geographic limit. Prior in-state flag was WRONG.',
  updated_at=now() WHERE state_code='GA';
UPDATE state_deposit_custody_rules SET geography_test='none', requires_in_state_depository=false,
  institution_test='"any bank or other lending institution subject to regulation by the state OR ANY AGENCY OF THE UNITED STATES GOVERNMENT" — no geographic limit.',
  updated_at=now() WHERE state_code='TN';
UPDATE state_deposit_custody_rules SET geography_test='none', requires_in_state_depository=false,
  institution_test='"bank or other lending institution subject to regulation by the Commonwealth of Kentucky OR ANY AGENCY OF THE UNITED STATES GOVERNMENT" — no geographic limit.',
  updated_at=now() WHERE state_code='KY';
UPDATE state_deposit_custody_rules SET geography_test='none',
  institution_test='"bank, credit union, or depository institution which is INSURED BY AN AGENCY OF THE FEDERAL GOVERNMENT" — no geographic limit.',
  updated_at=now() WHERE state_code='MO';
UPDATE state_deposit_custody_rules SET geography_test='none',
  institution_test='"a separate account at a FEDERALLY INSURED financial institution", separate from the agent operating account — no geographic limit. Applies to third-party agents, which is GAM.',
  updated_at=now() WHERE state_code='ID';
UPDATE state_deposit_custody_rules SET geography_test='none',
  institution_test='"a FEDERALLY INSURED interest-bearing savings or checking account for the benefit of the tenant" — no geographic limit.',
  updated_at=now() WHERE state_code='ND';
UPDATE state_deposit_custody_rules SET geography_test='none',
  institution_test='"a REGULATED FINANCIAL INSTITUTION" — no geographic limit. AND § 554.604(1) lets the landlord use the funds for any purpose on filing a cash/surety bond with the secretary of state.',
  updated_at=now() WHERE state_code='MI';
UPDATE state_deposit_custody_rules SET geography_test='none',
  institution_test='"an account of a bank or other financial institution under terms that place the security deposit beyond the claim of creditors of the landlord" — no geographic limit; the test is creditor-remoteness, not location.',
  updated_at=now() WHERE state_code='ME';
UPDATE state_deposit_custody_rules SET geography_test='none',
  institution_test='"a trust account in a bank, savings and loan association, or licensed escrow agent", wherever practicable — no geographic limit stated.',
  updated_at=now() WHERE state_code='AK';
UPDATE state_deposit_custody_rules SET geography_test='none',
  institution_test='escrow account at "an institution regulated by the Federal Reserve Board, the Federal Deposit Insurance Corporation or the Pennsylvania Department of Banking" — federal regulation suffices, no geographic limit.',
  updated_at=now() WHERE state_code='PA';
UPDATE state_deposit_custody_rules SET geography_test='none', requires_in_state_depository=false,
  institution_test='"banks, savings banks, or credit unions, the accounts of which are insured by the FDIC, the NCUA Share Insurance Fund, or other applicable" insurer — NO geographic limit. The "main banking premises in this State" phrase attaches to the RATE BENCHMARK (largest Illinois bank passbook rate), not to where the account sits.',
  updated_at=now() WHERE state_code='IL';

-- ── geography_test = 'doing_business' — a licensing test ────────────────
UPDATE state_deposit_custody_rules SET geography_test='doing_business',
  institution_test='"a trust account with a licensed and federally insured depository institution or a trust institution AUTHORIZED TO DO BUSINESS IN THIS STATE" — a licensing test, not a physical-office test. A bond from an insurer is an express ALTERNATIVE.',
  updated_at=now() WHERE state_code='NC';

-- ── geography_test = 'physical_office' — presence required ──────────────
UPDATE state_deposit_custody_rules SET geography_test='physical_office',
  institution_test='"escrow accounts ... in a financial institution", where "financial institution" is DEFINED as a bank/savings institution "that is LOCATED IN THIS STATE".',
  updated_at=now() WHERE state_code='CT';
UPDATE state_deposit_custody_rules SET geography_test='physical_office',
  institution_test='"an escrow bank account in a federally-insured banking institution WITH AN OFFICE THAT ACCEPTS DEPOSITS WITHIN THE STATE" — an explicit physical-office test.',
  updated_at=now() WHERE state_code='DE';
UPDATE state_deposit_custody_rules SET geography_test='physical_office',
  institution_test='"a separate, interest-bearing account in a bank, LOCATED WITHIN THE COMMONWEALTH", on terms placing the deposit beyond the landlord creditors'' claims.',
  updated_at=now() WHERE state_code='MA';
UPDATE state_deposit_custody_rules SET geography_test='physical_office',
  institution_test='deposits in six-or-more-family dwellings must sit in "a banking organization ... LOCATED IN THIS STATE".',
  updated_at=now() WHERE state_code='NY';
UPDATE state_deposit_custody_rules SET geography_test='physical_office',
  institution_test='"an escrow account ... MAINTAINED IN THE STATE OF OKLAHOMA with a federally insured financial institution". Misappropriation is criminal.',
  updated_at=now() WHERE state_code='OK';
UPDATE state_deposit_custody_rules SET geography_test='physical_office',
  institution_test='"a trust account ... in a financial institution or licensed escrow agent LOCATED IN WASHINGTON".',
  updated_at=now() WHERE state_code='WA';
UPDATE state_deposit_custody_rules SET geography_test='physical_office',
  institution_test='"a Florida financial institution", AND the statute separately bars hypothecating, pledging or "in any other way" making use of the funds — the second bar defeats any investment vehicle regardless of institution.',
  updated_at=now() WHERE state_code='FL';

-- ── geography_test = 'state_chartered' — the strictest ──────────────────
UPDATE state_deposit_custody_rules SET geography_test='state_chartered',
  institution_test='a single trust account "at any bank, savings and loan association or credit union ORGANIZED UNDER THE LAWS OF THIS STATE". A national charter does not satisfy this. Pooling ACROSS TENANTS is expressly allowed.',
  updated_at=now() WHERE state_code='NH';

-- ── no institution test at all; blocked for a different reason ──────────
UPDATE state_deposit_custody_rules SET geography_test='n/a',
  institution_test='NO institution requirement. Blocked instead by structure: each deposit into a "separate trust account ... as a private trustee" and "shall not commingle the trust funds with other money". Pooling itself is barred (mobile home parks).',
  updated_at=now() WHERE state_code='CO';

-- ── the three read-but-unresolved ──────────────────────────────────────
UPDATE state_deposit_custody_rules SET geography_test='none',
  institution_test='"may be held in a trust account, which MAY BE A COMMON TRUST ACCOUNT and which may be an interest bearing account" — permissive, pooling named, no institution or geography requirement. Interest earned is the landlord''s.',
  updated_at=now() WHERE state_code IN ('IA','KS');
UPDATE state_deposit_custody_rules SET geography_test='state_chartered',
  institution_test='at 10+ units, "shares of an insured money market fund established by an investment company BASED IN THIS STATE"; under 10 units, an insured New Jersey bank. Same shape as CT/NH — an in-state entity, not merely a licensed one.',
  updated_at=now() WHERE state_code='NJ';
