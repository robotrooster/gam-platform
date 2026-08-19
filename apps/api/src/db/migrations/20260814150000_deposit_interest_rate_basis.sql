-- S604 (Nic): deposit-interest statutes are not all flat percentages.
--
-- The catalog stored a single annual_rate_pct, which silently misreads two very
-- common statutory shapes and costs GAM real money:
--
--   MASSACHUSETTS G.L. c. 186 § 15B — "interest at the rate of five per cent per
--     year OR OTHER SUCH LESSER AMOUNT OF INTEREST AS HAS BEEN RECEIVED FROM THE
--     BANK where the deposit has been held". A lesser-of rule: the landlord can
--     never owe more than was actually earned. Seeded here as a flat 5.0000%,
--     this would have made GAM pay 5% while earning ~3% — a 2% loss on a large,
--     high-deposit apartment market that the statute never asked for. That
--     mis-encoding costs far more than the harshest statute we have found.
--
--   FLORIDA § 83.49 — the landlord ELECTS between "at least 75 percent of the
--     annualized average interest rate payable on such account" and "5 percent
--     per year, simple interest". Electing the 75% share guarantees a positive
--     spread. (FL also permits a non-interest-bearing account entirely, in which
--     case nothing is owed — captured by custody rules, not here.)
--
-- rate_basis:
--   'fixed'            — owe annual_rate_pct flat. The only basis that can go
--                        negative against market yield (e.g. AZ mobile home 5%).
--   'lesser_of_actual' — owe MIN(annual_rate_pct, actually earned). Cannot lose.
--   'share_of_actual'  — owe actual_share_pct % of what was actually earned.
--                        GAM keeps the remainder. Cannot lose.
--
-- Where a statute offers the landlord a CHOICE, encode the option that is
-- cheapest-but-lawful and record the alternative in `notes` — the election is
-- GAM's to make and there is no obligation to pick the more expensive one.
--
-- Backfill: existing rows are all flat statutory rates, so 'fixed' is the
-- correct default and preserves current behaviour — EXCEPT Massachusetts, which
-- is corrected below.

ALTER TABLE state_deposit_interest_rates
  ADD COLUMN IF NOT EXISTS rate_basis       text,
  ADD COLUMN IF NOT EXISTS actual_share_pct numeric(6,4);

UPDATE state_deposit_interest_rates SET rate_basis = 'fixed' WHERE rate_basis IS NULL;

ALTER TABLE state_deposit_interest_rates
  ALTER COLUMN rate_basis SET NOT NULL,
  ALTER COLUMN rate_basis SET DEFAULT 'fixed';

ALTER TABLE state_deposit_interest_rates
  DROP CONSTRAINT IF EXISTS sdir_rate_basis_check;
ALTER TABLE state_deposit_interest_rates
  ADD CONSTRAINT sdir_rate_basis_check CHECK (
    rate_basis IN ('fixed', 'lesser_of_actual', 'share_of_actual')
    AND (rate_basis <> 'share_of_actual' OR actual_share_pct IS NOT NULL)
  );

COMMENT ON COLUMN state_deposit_interest_rates.rate_basis IS
  'S604: how the obligation is computed. fixed = flat rate (only basis that can go negative vs market); lesser_of_actual = MIN(rate, earned) e.g. MA; share_of_actual = actual_share_pct%% of earned, e.g. FL 75%%.';
COMMENT ON COLUMN state_deposit_interest_rates.actual_share_pct IS
  'S604: for share_of_actual — the percentage of ACTUAL earnings owed to the tenant (FL 83.49 = 75).';

-- ── Corrections ───────────────────────────────────────────────────────────
-- MA was seeded flat 5%; the statute is lesser-of.
UPDATE state_deposit_interest_rates
   SET rate_basis = 'lesser_of_actual',
       statute_citation = 'Mass. G.L. c. 186 § 15B',
       notes = COALESCE(notes || ' | ', '') ||
               'S604: basis corrected to lesser-of. Statute reads "five per cent per year or other such lesser amount of interest as has been received from the bank where the deposit has been held" — GAM can never owe more than it earned here.'
 WHERE state_code = 'MA';

-- FL: landlord elects >=75% of actual OR 5% flat. Encode the 75% share — it is
-- the lawful option that cannot produce a loss.
INSERT INTO state_deposit_interest_rates
  (state_code, effective_year, annual_rate_pct, statute_citation, unit_types,
   act_key, rate_basis, actual_share_pct, notes)
VALUES
  ('FL', 2026, 5.0000, 'Fla. Stat. § 83.49', '{}', 'residential',
   'share_of_actual', 75.0000,
   'S604: landlord ELECTS between at least 75% of the annualized average rate on the account and 5% simple. GAM elects the 75% share — it tracks actual earnings so it can never go negative. annual_rate_pct records the 5% alternative for reference. NOTE: custody in FL is separately BLOCKED (must sit in a Florida financial institution; statute bars making use of the funds).')
ON CONFLICT (state_code, effective_year, unit_types) DO NOTHING;
