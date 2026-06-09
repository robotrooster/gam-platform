# FlexDeposit State Licensing Audit — Pre-Lawyer Pass

**Date:** 2026-05-18 (Session 303)
**Scope:** 15-state regulatory matrix for FlexDeposit launch sequencing.
**Author:** Claude (engineering pre-lawyer research). **Not legal advice.**

---

## ⚠ STATUS: ARCHIVAL — NOT THE ACTIVE PRODUCT MODEL

**Updated 2026-05-18 (Session 304).**

This memo was produced under the assumption that GAM would be the
**creditor** on FlexDeposit, extending consumer installment loans
to tenants. **That is not GAM's actual product structure.** Per
the platform's intentional design, GAM does not extend consumer
credit on any product, including FlexDeposit. FlexDeposit is
structured as a **Service-Level Agreement** between GAM and the
tenant — GAM voluntarily advances the deposit; the tenant agrees
to a payment schedule; **GAM has no legal recourse against the
tenant for non-payment**. Without an enforceable repayment
obligation, the consumer-installment-lending licensing regimes
analyzed below do not apply.

**Keep this memo as reference for two purposes:**

1. **If GAM ever pivots** to a creditor model for FlexDeposit (or
   any other product), the 15-state matrix below is the starting
   point for licensing-state selection.
2. **Recharacterization risk** — substance-over-form doctrine
   means a regulator or court could still recharacterize the SLA
   as credit if the substance of the transaction (advance + scheduled
   repayment + service fee) overrides the "no recourse" framing.
   Counsel should specifically validate the SLA structure
   pre-launch, with reference to CFPB earned-wage-access advisory
   activity and BNPL regulatory creep. If recharacterization risk
   materializes in any state, the licensing path in that state's
   card below is the fallback plan.

The remainder of this memo is preserved as originally written. Do
not treat the recommended launch sequence as an action plan; the
current product structure does not require state lender licensing.

---

## What this is, and what it isn't

**Is:** an engineering-level read of state consumer-installment-
lending law against the FlexDeposit product structure, flagging
which states accommodate the product, which require licensing
plus discipline, and which to defer or avoid at launch.

**Isn't:** a legal opinion. Final review by qualified counsel
licensed in each launch state is required before applying for
the license or launching the product. Particularly the
Massachusetts Chapter 93A exposure, California AB 539 / DFPI
posture, and New York 25%-criminal-usury risk warrant
state-specific counsel red-team.

---

## Product structure assumed

- **Creditor:** GAM Asset Management LLC (Delaware), holding the
  required state license in each launch state.
- **Loan type:** Closed-end consumer installment loan.
- **Principal:** $500–$3,000 (the deposit amount).
- **Term:** 12 months, fixed.
- **Rate:** Single fixed APR per loan, disclosed at origination
  per TILA / Reg Z.
- **Security:** Unsecured. The deposit is held by GAM (or the
  Landlord on legacy migrations) but the deposit is the Landlord's
  obligation to the Tenant; GAM cannot repossess against it.
- **Reporting:** Tenant-elected reporting to consumer reporting
  agencies (with FCRA furnisher obligations attaching whenever
  GAM reports).
- **Underwriting:** Soft pull / screening provider; explicit FCRA
  authorization at enrollment; adverse-action notices on decline.

---

## TL;DR — recommended launch sequence

**Every target state requires a license.** There is no "no-license"
path for closed-end consumer installment lending at the
$500–$3,000 principal range in any of the 15 states audited.
GAM cannot launch FlexDeposit nationally without state-by-state
licensure.

**Five-state recommended first wave** (ordered by ease + economics):

1. **Arizona** — HQ; DIFI is the home regulator; A.R.S. § 6-632
   accommodates 36% in the relevant principal bracket; clean
   single-license path. **Top priority.**
2. **Texas** — Subchapter F of Tex. Fin. Code Chapter 342 is
   purpose-built for small-dollar installment lending; OCCC is a
   mature regulator; effective APR ceiling is 32–48%.
3. **Georgia** — Highest effective APR ceiling of the 15 (∼50–60%
   via the Installment Loan Act fee structure); Renter's Choice
   bill creates market-tailwind alignment.
4. **Florida** — Post-2024 amendments to § 516.031 set a 36% APR
   cap on the relevant bracket; OFR has been responsive.
5. **Nevada** — Second on GAM's stated roadmap; Chapter 675 has
   no hard APR cap (most permissive of the 15); per-office
   licensing increases overhead but accommodates RV-park
   operators specifically.

**Second wave** (workable but constrained): Oregon, Illinois,
North Carolina, New Jersey.

**Third wave / requires structural compliance work**: California
(mandatory CRA reporting + credit-ed curriculum), Massachusetts
(Chapter 93A treble exposure), Washington, Colorado,
Pennsylvania.

**Avoid for launch wave**: New York (1-month deposit cap shrinks
the FlexDeposit principal economics; 25% criminal-usury ceiling
is tight; ongoing BNPL rulemaking volatility).

---

## Per-state rankings (15 states)

### Tier 1 — First Wave (5 states)

#### Arizona — LICENSING-REQUIRED, top priority

- **Regulator:** AZ Department of Insurance & Financial
  Institutions (DIFI), Financial Enterprises Division.
- **License:** Consumer Lender License, A.R.S. Title 6, Chapter
  5 (§§ 6-601 et seq.). Required for closed-end loans ≤$10,000.
- **APR cap:** 36% in the lowest principal bracket (under $3,000)
  per A.R.S. § 6-632; tiered structure scales down on higher
  principals.
- **Capital / bond:** $25K liquid net worth requirement; surety
  bond per regulation.
- **Time-to-license:** 90–180 days via NMLS.
- **Deposit-statute friction:** None. A.R.S. § 33-1321 caps
  landlord deposits at 1.5x monthly rent and doesn't restrict
  third-party advance.
- **Why first:** GAM's home state; the regulator is the natural
  first relationship; APR ceiling accommodates the product.

#### Texas — LICENSING-REQUIRED, purpose-built statute

- **Regulator:** Texas Office of Consumer Credit Commissioner
  (OCCC).
- **License:** Regulated Lender License under Tex. Fin. Code
  Chapter 342, Subchapter F (small-dollar / signature loans).
- **APR cap:** No hard APR ceiling; Subchapter F's structured
  fee model yields effective APRs typically 32–48% on
  small-dollar principals.
- **Capital / bond:** $25K net worth; surety bond.
- **Time-to-license:** 60–120 days via NMLS.
- **Deposit-statute friction:** None. Tex. Prop. Code §§ 92.101–
  .109 govern landlord deposit handling, not financing source.
- **Why second:** Subchapter F is the closest match to
  FlexDeposit's exact product profile in any of the 15 states.

#### Georgia — LICENSING-REQUIRED, highest effective ceiling

- **Regulator:** Georgia Department of Banking and Finance
  (DBF, post-2020 transfer from the Industrial Loan
  Commissioner).
- **License:** Installment Loan License under O.C.G.A. §§ 7-3-1
  et seq. (Installment Loan Act). Required for loans ≤$3,000.
- **APR cap:** Effective ceiling ∼50–60% via the Act's fee
  structure: 10% base interest + 8% fee on first $600 / 4% fee
  on excess + $3/month maintenance charge. Well-established and
  accepted by DBF.
- **Deposit-statute friction:** None. Georgia's Renter's Choice
  bill creates upside synergy — landlords may be required to
  offer security-deposit alternatives, of which FlexDeposit
  is one.
- **Why third:** Highest effective APR ceiling among the 15;
  Renter's Choice gives market tailwind.

#### Florida — LICENSING-REQUIRED, post-2024 amendments favorable

- **Regulator:** Florida Office of Financial Regulation (OFR),
  Division of Consumer Finance.
- **License:** Consumer Finance Company license, Fla. Stat.
  Chapter 516 (Florida Consumer Finance Act).
- **APR cap:** 36% on first $10,000 of principal per § 516.031
  (effective July 1, 2024). Tiered down for higher balances.
- **Capital / bond:** $25K minimum net assets; surety bond
  per location.
- **Time-to-license:** 60–120 days via the OFR REAL system.
- **Deposit-statute friction:** None. Fla. Stat. § 83.49
  governs landlord deposit handling but doesn't restrict
  third-party financing.
- **Why fourth:** 2024 amendments aligned the FL framework to
  the 36% national norm; market is large; OFR is responsive.

#### Nevada — LICENSING-REQUIRED, most permissive rate environment

- **Regulator:** Nevada Financial Institutions Division (FID).
- **License:** Installment Loan License under NRS Chapter 675.
  **Each office requires a separate license** (NRS 675.090) —
  notable operational overhead for multi-property operators.
- **APR cap:** No hard APR cap. The most permissive of the 15.
  Stay clear of NRS 604A (high-interest / payday) by keeping
  APR <40%.
- **Capital / bond:** Per-office structured.
- **Deposit-statute friction:** None. NRS 118A.240–.250 govern
  landlord deposits; no third-party financing restriction.
- **Why fifth:** GAM's stated post-Arizona expansion target.
  Per-office licensing is the catch; multi-state SaaS deployment
  may need a different operational model than single-state
  brick-and-mortar lenders.

### Tier 2 — Second Wave (4 states)

#### Oregon — LICENSING-REQUIRED, 36% all-in cap

- **License:** Consumer Finance License under ORS Chapter 725.
- **APR cap:** **36% all-in (MAPR-style)** — the strictest of
  the licensed states. All fees, late charges, and finance
  charges must compute to ≤36% APR. Tight but workable.
- **Why second wave:** All-in cap forces clean fee structure
  with no room for ancillary charges; manageable but
  demanding.

#### Illinois — LICENSING-REQUIRED, 36% MAPR (PLPA)

- **License:** Consumer Installment Loan Act (CILA, 205 ILCS
  670) license.
- **APR cap:** **36% all-in MAPR** under the Predatory Loan
  Prevention Act (815 ILCS 123, effective March 23, 2021).
  Loans exceeding 36% MAPR are null and void — lender cannot
  collect any principal, interest, or fees. $10K per-violation
  fine.
- **Why second wave:** PLPA is unforgiving; computation
  discipline is mandatory; reward for getting it right is a
  large rental market.

#### North Carolina — LICENSING-REQUIRED, tiered structure

- **License:** Consumer Finance Act (N.C. Gen. Stat. Chapter 53
  Article 15) license, post-October 1, 2023 amendments.
- **APR cap:** Tiered: 36% on first $4,000; 24% on
  $4,000.01–$8,000; 18% above. 12-month minimum term aligns
  with FlexDeposit's standard term.
- **Why second wave:** 36% bracket fits FlexDeposit principals
  squarely; NCCOB is a strict but predictable regulator.

#### New Jersey — LICENSING-REQUIRED, 30% criminal-usury ceiling

- **License:** Consumer Finance Licensing Act (N.J.S.A. 17:11C-1
  et seq.).
- **APR cap:** 30% criminal usury (N.J.S.A. 2C:21-19) is the
  hard ceiling for individual borrowers. Licensed lenders may
  contract for any rate up to that ceiling.
- **Why second wave:** Accommodates target APR; Atalese
  arbitration jurisprudence requires extra plain-English
  recital language in the FlexDeposit credit agreement;
  deposit statute (N.J.S.A. 46:8-19) is among the most
  prescriptive nationally but doesn't block third-party
  financing.

### Tier 3 — Third Wave / Constrained (4 states)

#### California — LICENSING-REQUIRED, AB 539 structural issues

- **License:** California Financing Law (CFL) license, DFPI.
- **APR cap:** For principals $2,500–$10,000, AB 539 (Fin. Code
  § 22304.5) caps simple interest at **36% + Federal Funds
  Rate**.
- **Structural friction:**
  1. **AB 539 mandatory CRA reporting** — for $2,500+ loans,
     lender MUST report payment performance to at least one
     nationwide CRA. **This conflicts with FlexDeposit's
     "tenant-elected" reporting model.** Restructure required.
  2. **Mandatory free credit-education curriculum** — DFPI-
     approved program required for borrowers. Operational lift.
  3. **12-month minimum term** for $2,500+ loans — aligns
     with FlexDeposit's standard 12-month term.
  4. **Sub-$2,500 principal exposure to UDAAP** — loans under
     $2,500 are inside CFL but outside AB 539's 36% ceiling;
     DFPI's CCFPL UDAAP authority discourages high rates on
     small principals.
- **Why third wave:** License pathway is 6–12 months; structural
  compliance lift (mandatory CRA, credit-ed curriculum) is
  significant; California's enforcement posture means launching
  here without counsel is high-risk.

#### Massachusetts — LICENSING-REQUIRED, Ch. 93A treble exposure

- **License:** Small Loan Company license, Mass. Gen. Laws ch.
  140 § 96.
- **APR cap:** **23%** per annum simple interest for licensed
  small-loan companies (ch. 140 § 100; 209 CMR 26.01). Tight.
- **Structural friction:** Chapter 93A consumer protection
  imposes treble damages and attorneys' fees on any unfair-or-
  deceptive disclosure failure. Mass. Gen. Laws ch. 186 § 15B
  (deposit statute) is the most landlord-punitive in the country
  — disclosure complexity in any FlexDeposit communication
  that touches the deposit is high.
- **Why third wave:** 23% ceiling thin; Ch. 93A treble exposure
  is a material regulatory tax on any misstep.

#### Washington — LICENSING-REQUIRED, 25% ceiling

- **License:** Consumer Loan Company license, RCW 31.04
  (Consumer Loan Act).
- **APR cap:** **25%** per annum (RCW 31.04.105). Hard cap.
- **Why third wave:** 25% ceiling is below ideal; manageable
  on the FlexDeposit profile if origination + finance charge
  compute under the cap.

#### Colorado — LICENSING-REQUIRED, tiered cap + DIDMCA opt-out

- **License:** Supervised Lender License under C.R.S. Title 5
  (Colorado UCCC).
- **APR cap:** Tiered under § 5-2-201: 36% on first $1,000; 21%
  on $1,000.01–$3,000; 15% above $3,000. **HB23-1229 opted
  Colorado out of federal DIDMCA interest-rate exportation
  effective July 1, 2024** — closes the bank-partnership rate-
  export loophole.
- **Why third wave:** Blended APR on a $1,500 FlexDeposit lands
  in the high-20s; on $2,500 in the low-20s. Workable but
  margins are tight.

### Tier 4 — Avoid for Launch (1 state)

#### New York — COMPLEX / AVOID

- **License:** Licensed Lender license under Banking Law Article
  9, § 340. Application via NMLS.
- **APR cap:** Civil usury at 16% (Gen. Oblig. Law § 5-501);
  criminal usury at 25% (Penal Law § 190.40). Practical
  ceiling: 25%.
- **Structural friction:**
  1. **NY Real Property Law § 238-a caps residential deposits
     at 1 month's rent** (Housing Stability and Tenant
     Protection Act of 2019). FlexDeposit's economics scale
     with deposit size; shrinking to 1 month meaningfully
     reduces both addressable market and per-loan revenue.
  2. **NY Gen. Oblig. Law § 7-103 trust-account framework**
     — deposits must be held in trust; FlexDeposit advances
     to a trust account require careful structuring.
  3. **25% criminal usury ceiling** is below FlexDeposit's
     likely target APR.
  4. **Ongoing BNPL rulemaking volatility** — the 2025 BNPL
     Act and 2026 proposed implementing rules create
     regulatory uncertainty in the consumer-credit space.
- **Why avoid at launch:** All four frictions compound. Defer
  until product is mature and economics absorb a tighter
  spread.

### Pennsylvania — LICENSING-REQUIRED but downgrade to Tier 3

- **License:** Consumer Discount Company Act (CDCA, 7 P.S.
  § 6201 et seq.) license.
- **APR cap:** Effective 24% ceiling for CDCA licensees (per
  fee + interest + discount mix in 7 P.S. § 6213).
- **Structural friction:** PA AG is one of the most active
  "true lender" enforcers nationally (2024 SoLo Funds AVC). All-
  in cost-of-credit interpretation is aggressive.
- **Why third wave:** 24% effective ceiling tight; aggressive
  AG enforcement adds risk.

---

## Cross-cutting compliance items (apply in every launch state)

### Federal layer

- **TILA / Regulation Z** disclosures apply to every FlexDeposit
  loan nationally: APR, finance charge, amount financed, total
  of payments, payment schedule, late-payment policy. Must be
  delivered in the prescribed format with specific box layouts
  for closed-end credit.
- **FCRA** — when GAM pulls a consumer report for underwriting,
  FCRA authorization + adverse-action notices apply. When GAM
  furnishes payment data to a CRA, FCRA § 623 furnisher
  obligations attach (accuracy, dispute investigation, etc.).
- **ECOA / Reg B** — no discrimination on race, color, religion,
  national origin, sex, marital status, age, or because income
  derives from public assistance. Adverse-action notices for
  credit denials.
- **Military Lending Act (MLA) — 36% MAPR cap** on loans to
  covered borrowers (active-duty service members and their
  dependents). MAPR includes credit insurance, fees, ancillary
  charges. **Covered-borrower status must be checked at
  origination** via the DoD's MLA database or a CRA flag. If
  the borrower is covered, the FlexDeposit APR must compute to
  ≤36% MAPR regardless of state ceiling.
- **CFPB UDAAP** authority covers all consumer-credit
  activity nationally. State-level UDAP statutes layered on top
  (CA UCL/CLRA/FAL, NJ CFA, MA Ch. 93A, etc.) per the S299
  ToS review.

### State layer (every launch state)

- **License renewal** typically annual; bond maintenance
  ongoing.
- **Per-loan disclosures** state-specific in some cases (FL
  credit-education at origination; CA mandatory CRA reporting +
  credit-ed curriculum).
- **Examination readiness** — state regulators conduct periodic
  exams (typically every 1–3 years). FlexDeposit records,
  underwriting files, complaint logs, and TILA disclosures must
  be retained per state-specific retention rules.

---

## Recommended operational rollout

**Phase 1 (months 0–6):** Single-state launch in Arizona.
- DIFI license application via NMLS.
- $25K liquid net worth + surety bond.
- TILA/Reg Z disclosure template draft (one disclosure works
  nationally; state-specific addenda can be added later).
- FCRA underwriting + adverse-action workflow.
- MLA covered-borrower check at origination.
- AZ-specific FlexDeposit credit agreement template.

**Phase 2 (months 6–12):** Texas + Georgia + Florida + Nevada.
- Apply for licenses in all four states in parallel; expect
  60–120 day windows.
- Add state-specific disclosure addenda for each.
- For Nevada specifically: decide on the per-office license
  model — if GAM operates a single online lending office, only
  one NV license is needed; if FlexDeposit is sold per-property,
  per-office licensing scales overhead.

**Phase 3 (months 12–18):** Tier 2 second wave.
- Oregon, Illinois, North Carolina, New Jersey.
- All-in MAPR discipline required for OR + IL.

**Phase 4 (months 18+):** Tier 3 with counsel red-team.
- California requires structural changes (mandatory CRA
  reporting + credit-ed curriculum) — work this thoroughly
  before applying.
- Massachusetts Ch. 93A exposure means counsel involvement
  on every disclosure template.

**Defer indefinitely (or until product matures):** New York.

---

## Key product-design implications from this audit

1. **The FlexDeposit credit agreement template needs state-
   specific disclosure addenda** because every state has its
   own required disclosures, late-fee caps, and rate-tier
   rules. A single national template won't satisfy any state
   examiner; expect to maintain a base agreement + per-state
   appendix.
2. **APR target should be 35.9%** (just under 36%) to comply
   with the all-in MAPR-style caps in Oregon, Illinois, and
   the Military Lending Act simultaneously. Higher APR forces
   different products per state.
3. **Tenant-elected CRA reporting conflicts with California
   AB 539's mandatory CRA reporting** for $2,500+ loans. Either
   restructure to make California loans mandatory-reporting
   (worse UX), or keep loans under $2,500 in California (smaller
   addressable principal in a high-deposit state).
4. **The per-office licensing in Nevada** means a single Stripe-
   based online origination model is cleaner than a per-property
   model. Confirm operational structure before applying.
5. **Origination fee compression** — Oregon (36% all-in) and
   Illinois (36% MAPR) require zero or minimal origination fees;
   all charges fold into the APR cap. The FlexDeposit credit-
   agreement template should not assume an uncapped origination
   fee.
6. **Reporting partners for AB 539 California compliance** —
   the mandatory CRA reporting requirement names "at least one
   nationwide consumer reporting agency." Select the partner
   that meets AB 539's framework before launching in CA.

---

## Items deferred to actual counsel engagement

- **Per-state license application advisory** — once Tier 1
  states are selected, counsel files the NMLS applications and
  manages regulator communications.
- **TILA disclosure template review** — TILA box layout has
  specific font, ordering, and proximity requirements that
  counsel must validate.
- **AB 539 mandatory CRA reporting partner selection** — CA-
  specific structuring.
- **MLA covered-borrower check workflow** — federal compliance
  routing.
- **Ch. 93A disclosure red-team** — Massachusetts-specific.
- **PA "true lender" risk assessment** — given PA AG's
  enforcement posture, structuring FlexDeposit so GAM is
  unambiguously the lender (not a bank-partnership pass-through)
  is critical.
- **NV per-office licensing strategy** — operational decision
  with regulatory consequences.
- **CO DIDMCA opt-out analysis** — confirm no inadvertent rate-
  export structures.

---

## Sources

State statutes:
- A.R.S. Title 6, Chapter 5 (AZ Consumer Lender)
- A.R.S. §§ 6-602, 6-632 (AZ usury / fees)
- A.R.S. § 33-1321 (AZ deposit cap)
- Tex. Fin. Code Chapter 342 + Subchapter F (TX Regulated
  Lender)
- Tex. Prop. Code §§ 92.101–.109 (TX deposit)
- Fla. Stat. Chapter 516 + § 516.031 (FL Consumer Finance Act,
  post-2024)
- Fla. Stat. § 83.49 (FL deposit)
- Cal. Fin. Code Div. 9 §§ 22000 et seq. (CA Financing Law)
- Cal. Fin. Code § 22304.5 (CA AB 539 / Fair Access to Credit)
- Cal. Civ. Code § 1950.5 (CA deposit; reduced to 1x rent per
  AB 12 effective July 1, 2024)
- N.Y. Banking Law Art. 9 § 340 (NY Licensed Lender)
- N.Y. Gen. Oblig. Law §§ 5-501, 7-103 (NY usury / deposit
  trust)
- N.Y. Real Property Law § 238-a (NY 1-month deposit cap)
- N.J.S.A. 17:11C-1 et seq. (NJ Consumer Finance Licensing
  Act); § 17:11C-32 (NJ rate cap)
- N.J.S.A. 2C:21-19 (NJ criminal usury)
- N.J.S.A. 46:8-19 (NJ deposit)
- Mass. Gen. Laws ch. 140 §§ 96, 100 (MA Small Loan Act)
- 209 CMR 26.00 (MA Small Loans regs)
- Mass. Gen. Laws ch. 93A (MA consumer protection)
- Mass. Gen. Laws ch. 186 § 15B (MA deposit)
- ORS Chapter 725 (OR Consumer Finance)
- ORS 90.300 (OR deposit)
- NRS Chapter 675 (NV Installment Loans)
- NRS 118A.240 (NV deposit)
- C.R.S. Title 5 (CO UCCC); § 5-2-201 (CO tiered rates)
- HB23-1229 (CO DIDMCA opt-out)
- C.R.S. § 38-12-103 (CO deposit)
- RCW 31.04 (WA Consumer Loan Act); § 31.04.105 (WA 25% cap)
- RCW 59.18.270 (WA deposit)
- 205 ILCS 670 (IL CILA)
- 815 ILCS 123 (IL Predatory Loan Prevention Act)
- 765 ILCS 715 / 710 (IL deposit)
- O.C.G.A. Title 7 Chapter 3 (GA Installment Loan Act)
- O.C.G.A. § 7-4-2 (GA general usury)
- O.C.G.A. § 44-7-30 (GA deposit)
- N.C. Gen. Stat. Chapter 53 Article 15 (NC Consumer Finance
  Act, post-October 2023)
- N.C. Gen. Stat. § 42-50 (NC Tenant Security Deposit Act)
- 7 P.S. § 6201 et seq. (PA Consumer Discount Company Act)
- 41 P.S. § 201 (PA Loan Interest and Protection Law)
- 68 P.S. § 250.511a (PA deposit)

Federal:
- 12 CFR Part 226 / Regulation Z (TILA)
- 15 U.S.C. § 1681 et seq. (FCRA)
- 12 CFR Part 1002 / Regulation B (ECOA)
- 10 U.S.C. § 987 + 32 CFR Part 232 (MLA — 36% MAPR cap)
- 12 U.S.C. § 5481 et seq. (CFPB / Dodd-Frank UDAAP)

Regulator URLs:
- DIFI (AZ): https://difi.az.gov
- OCCC (TX): https://occc.texas.gov
- OFR (FL): https://flofr.gov
- DFPI (CA): https://dfpi.ca.gov
- NYDFS: https://dfs.ny.gov
- NJDOBI: https://www.state.nj.us/dobi
- MA DOB: https://www.mass.gov/orgs/division-of-banks
- OR DFR: https://dfr.oregon.gov
- NV FID: https://fid.nv.gov
- CO AG UCCC Unit: https://coag.gov/office-sections/consumer-
  protection/consumer-credit-unit/
- WA DFI: https://dfi.wa.gov
- IDFPR (IL): https://idfpr.illinois.gov
- GA DBF: https://dbf.georgia.gov
- NCCOB (NC): https://nccob.nc.gov
- PA DoBS: https://www.dobs.pa.gov

---

**End of pre-lawyer pass.** This memo identifies the regulatory
shape of each target state and proposes a launch sequence
optimized for ease + economics. Apply at your own risk, and
**engage qualified counsel licensed in each launch state before
applying for the license** — particularly for the structural
compliance work in California (AB 539 + DFPI) and the
disclosure-quality work in Massachusetts (Chapter 93A) and
Pennsylvania (CDCA + AG enforcement).
