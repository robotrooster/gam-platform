-- S604: CT and IL custody provisions, now READ (they were genuinely unread —
-- the earlier "all 50 states read" claim covered INTEREST, not custody).
--
-- CT § 47a-21 — the landlord "shall immediately deposit the entire amount of any
--   security deposit received by such landlord from each tenant into one or more
--   escrow accounts established or maintained in a financial institution for the
--   benefit of each tenant", and "shall maintain each such account as escrow
--   agent". The section DEFINES "financial institution" as a state bank and trust
--   company, national bank, savings bank, federal savings bank, or savings and
--   loan "that is LOCATED IN THIS STATE". In-state depository required.
--
-- IL 765 ILCS 745/18 — deposits must be held at "banks, savings banks, or credit
--   unions, the accounts of which are insured by the Federal Deposit Insurance
--   Corporation, the National Credit Union Administration Share Insurance Fund,
--   or other applicable" insurer, and "shall not be commingled with the assets of
--   the park owner ... nor subject to the claims of any creditor of the park
--   owner". A federally insured depository is required.
--
-- Both are therefore BLOCKED for a brokerage Treasury position.
--
-- REMAINING: IA, KS, NJ stay needs_research — but they are READ, not unread.
-- Their texts are known and simply do not resolve the question:
--   IA § 562A.12 / KS § 58-25,108 — deposits "may be held in a trust account,
--     which may be a COMMON trust account and which may be an interest bearing
--     account". Permissive and pooling-friendly, but whether a Treasury position
--     qualifies as a "trust account" is a legal judgment, not a reading question.
--   NJ § 46:8-19 — permits an insured money market fund from an investment
--     company "based in this State"; whether any qualifying fund exists that GAM
--     can use is a diligence question for counsel/Jiko.

UPDATE state_deposit_custody_rules
   SET custody_status = 'blocked', allows_treasury_bills = false,
       requires_in_state_depository = true, requires_federally_insured = true,
       statute_citation = 'Conn. Gen. Stat. § 47a-21',
       notes = 'Landlord "shall immediately deposit the entire amount of any security deposit ... into one or more escrow accounts established or maintained in a financial institution for the benefit of each tenant" and "shall maintain each such account as escrow agent". The section defines "financial institution" as a bank/savings institution "that is LOCATED IN THIS STATE". Interest side is index-linked (deposit index, § 36a-26) and covers mobile manufactured homes and parks as well as residential.',
       researched_at = '2026-08-14', updated_at = now()
 WHERE state_code = 'CT';

UPDATE state_deposit_custody_rules
   SET custody_status = 'blocked', allows_treasury_bills = false,
       requires_federally_insured = true,
       statute_citation = '765 ILCS 745/18',
       notes = 'Deposits must be held at "banks, savings banks, or credit unions, the accounts of which are insured by the Federal Deposit Insurance Corporation, the National Credit Union Administration Share Insurance Fund, or other applicable" insurer, and "shall not be commingled with the assets of the park owner", nor be subject to any creditor claim through the park owner. Federally insured depository required. Interest side: passbook rate of the largest Illinois-headquartered commercial bank, for parks of 25+ spaces, covering mobile home AND RV park tenants.',
       researched_at = '2026-08-14', updated_at = now()
 WHERE state_code = 'IL';

-- Make the distinction explicit on the three that remain, so nobody re-reads
-- statutes that have already been read.
UPDATE state_deposit_custody_rules
   SET notes = notes || ' [S604 STATUS: READ, NOT UNREAD. The statutory text is known and recorded; what is unresolved is whether GAM''s vehicle qualifies under it — a legal/diligence question for counsel, not further statute reading.]',
       updated_at = now()
 WHERE state_code IN ('IA','KS','NJ');
