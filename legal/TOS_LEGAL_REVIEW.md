# TOS Legal Review — Pre-Lawyer Pass

**Date:** 2026-05-16 (Session 299)
**Scope:** `legal/TERMS_OF_SERVICE.md`, current version.
**Author:** Claude (engineering pre-lawyer review). **Not legal advice.**

---

## What this is, and what it isn't

**Is:** an engineering-level read of GAM's current ToS against
state law in target markets, flagging the highest-risk
enforceability gaps with statute / case citations and concrete
copy-fix proposals.

**Isn't:** a legal opinion. The clauses below identify real
exposure, but the analysis is research, not licensed advice.
**Qualified counsel licensed in each target jurisdiction must
review before public launch** — ideally a multi-state
consumer-class-action specialist who can red-team the
McGill / Atalese / Feeney exposure.

---

## TL;DR — the single biggest issue

**GAM's ToS is one document binding two audiences with
fundamentally different legal profiles:**

- **Business users** (landlords, PM companies, their employees)
  — sophisticated, repeat-player, fee-paying. Most current
  clauses are enforceable against this group.
- **Residential tenants** — consumers, often adhesive, in most
  cases paying zero direct platform fees. The same clauses face
  state consumer-protection scrutiny and several are likely
  unenforceable as written.

**Recommended structural fix:** split into two documents —
`BUSINESS_TERMS.md` (current ToS, lightly modified) and
`CONSUMER_TERMS.md` (consumer-protection-aware version for
tenants). This is the single highest-leverage change. Almost
every per-clause fix below collapses if the split happens
because the aggressive risk-allocation gets to keep working on
the business side without dragging consumer scrutiny across it.

If the split isn't possible pre-launch, the in-place fixes
below at minimum address the most likely-to-be-challenged
clauses.

---

## Top 7 risks, ranked by severity

### Risk 1 — $0 liability cap for tenants (Section 16)

**Current language** (§ 16): *"GAM's aggregate liability… is
limited to the total Platform Fees you paid to GAM in the 90
days immediately preceding… the event giving rise to the
claim, or… the termination of your account. If you paid no
Platform Fees in that window, GAM's aggregate liability is
zero."*

**Problem.** Tenants typically pay **zero** direct platform
fees (per-occupied-unit + per-property minimum are landlord-paid
by default; even passed-through ACH/card processing fees are
not "Platform Fees" under the section's own definition).
So the cap is functionally **zero** for the consumer-tenant —
total exemption.

**State analysis:**
- **California** — Cal. Civ. Code § 1668 voids contracts that
  exempt anyone from responsibility for their own fraud,
  willful injury, or violation of law. A $0 cap is functional
  exemption. Likely unenforceable for any willful conduct,
  fraud, UCL, CLRA, or FCRA pass-through claim by a tenant.
- **New York** — *Kalisch-Jarcho, Inc. v. City of New York*,
  58 N.Y.2d 377 (1983) voids exculpatory clauses for gross
  negligence or willful misconduct. Substantive unconscionability
  under *Brower v. Gateway 2000*, 246 A.D.2d 246 (1st Dep't 1998),
  applies on top.
- **Massachusetts** — *H1 Lincoln, Inc. v. South Washington
  Street, LLC*, 489 Mass. 1 (2022), explicitly holds
  limitation-of-liability provisions unenforceable against
  willful or knowing Chapter 93A violations.
- **Arizona** — *Maxwell v. Fidelity Financial Services*,
  184 Ariz. 82 (1995), recognizes substantive unconscionability
  alone as voidance. A $0 cap is the textbook Maxwell scenario.
- **NJ / OR** — NJ Consumer Fraud Act + TCCWNA (N.J.S.A. 56:12-14)
  and Oregon UTPA (ORS 646.638) supply parallel public-policy
  voids for caps purporting to nullify consumer remedies.

**Proposed copy fix.** Add a non-zero floor + explicit
willful-conduct carve-outs:

> *"For consumer users (Tenants), GAM's aggregate liability
> is limited to the GREATER of (a) the total fees paid by the
> consumer to GAM in the 12 months preceding the claim, or
> (b) one hundred dollars ($100), subject to the carve-outs in
> this Section."*
>
> *"This limitation does NOT apply to (i) GAM's own willful
> misconduct, fraud, or gross negligence; (ii) GAM's violation
> of the FCRA, Fair Housing Act, or any state-law equivalent;
> (iii) GAM's violation of consumer-protection statutes
> (California UCL/CLRA/FAL, New Jersey CFA, Massachusetts
> Chapter 93A, Oregon UTPA, or analogous laws); (iv) any
> obligation to indemnify the consumer; or (v) any liability
> that cannot be limited as a matter of law."*

Keep the original aggressive cap on the **business** side
(landlords, PM companies).

---

### Risk 2 — McGill blow-up clause (Section 19.3)

**Current language** (§ 19.3): *"If a court of competent
jurisdiction determines that this class action waiver is
unenforceable as to a particular claim or remedy, then that
claim or remedy (and only that claim or remedy) will be
severed from arbitration and brought in court."*

Combined with § 19.4: *"the class action waiver in Section
19.3 cannot be severed by an arbitrator. If the class action
waiver is found unenforceable, the entire arbitration
agreement is unenforceable as to the affected claim."*

**Problem.** California's *McGill v. Citibank*, 2 Cal.5th 945
(2017), holds that a pre-dispute waiver of the right to seek
**public injunctive relief** under UCL/CLRA/FAL is contrary
to Cal. Civ. Code § 3513 and unenforceable; the FAA does not
preempt. Tenants asserting UCL or CLRA claims routinely
request public injunctive relief. The class-action waiver
read to bar public injunctive relief = McGill defect.

The current § 19.3/19.4 blow-up converts a McGill defect into
**total loss of arbitration** for that claim — a perverse
outcome. The drafter probably meant this as a poison pill
against splitting class waivers, but in practice it triggers
on every UCL/CLRA claim by a CA tenant.

**State analysis:**
- **California** — McGill rule directly applies. *Blair v.
  Rent-A-Center*, 928 F.3d 819 (9th Cir. 2019), confirmed FAA
  doesn't preempt McGill.
- **New Jersey** — *Atalese v. U.S. Legal Services Group*,
  219 N.J. 430 (2014), requires plain-English consumer assent
  to waiver of jury/court access; § 19.2's "binding
  arbitration administered by AAA under Consumer Arbitration
  Rules" likely fails Atalese for the tenant side.
- **Federal** — *Henry Schein v. Archer & White*, 586 U.S. 63
  (2019), and *Coinbase v. Suski*, 602 U.S. 143 (2024), define
  the delegation envelope. AAA Consumer Rules R-14(a)
  incorporated by § 19.2 supplies clear-and-unmistakable
  delegation — that piece is OK.
- **Other target states (NY, MA, OR, AZ)** — no McGill analog;
  arbitration clauses generally enforceable but subject to
  unconscionability scrutiny.

**Proposed copy fix.** Three parts:

1. **Explicit California public-injunctive carve-out** (preserves
   the rest of arbitration):
   > *"Notwithstanding anything in this Section 19 to the
   > contrary, the right to seek public injunctive relief on
   > behalf of the general public under the California UCL
   > (Bus. & Prof. Code § 17200), CLRA (Civ. Code § 1750
   > et seq.), or FAL (Bus. & Prof. Code § 17500) is preserved
   > in court. This carve-out is severable; if held
   > unenforceable, it shall be severed and the remainder of
   > Section 19 shall remain in full force."*

2. **Atalese-compliant plain-English recital** in § 19.2
   (consumer-tenant track):
   > *"By agreeing to arbitration in this Section 19, YOU ARE
   > GIVING UP YOUR RIGHT TO BRING A CLAIM IN COURT, INCLUDING
   > YOUR RIGHT TO A JURY TRIAL. The arbitrator decides the
   > dispute, not a judge or jury. Court rules of evidence and
   > procedure do not apply. Appeal rights are limited."*

3. **Drop or rewrite the § 19.4 blow-up trigger** — don't make
   class-waiver unenforceability collapse the entire arbitration
   agreement for the affected claim. Limit blow-up to the
   class-waiver provision itself; let arbitration of individual
   claims proceed.

---

### Risk 3 — Atalese plain-English failure (Section 19.2)

**Current language.** § 19.2 says: *"any claim, controversy,
or dispute arising out of or relating to these Terms or the
Platform… will be resolved exclusively through final and
binding arbitration administered by the American Arbitration
Association ('AAA') under its then-current Consumer
Arbitration Rules."*

**Problem.** New Jersey's *Atalese* line (and recent
appellate development through *Pace v. Hamilton Cove*, 258
N.J. 82 (2024)) requires that a consumer arbitration clause
**clearly and unambiguously** tell the consumer they are
giving up the right to a jury trial and to a judicial forum,
in plain language understandable to a reasonable consumer.
"Binding arbitration administered by AAA" doesn't recite the
rights waiver in plain English.

The 2023 NJ Appellate Division (cited in *Skinner v. Wells
Fargo Bank, N.A.*-line cases) limits Atalese to
non-sophisticated parties, so the clause is probably fine for
business landlords but defective for tenants.

**Proposed copy fix:** the plain-English recital in Risk 2 fix
above resolves this.

---

### Risk 4 — Overbroad tenant indemnification (Section 17)

**Current language.** § 17 requires the user (including
Tenants) to indemnify GAM against any claim arising from
"violation of any applicable law, including without
limitation the Fair Housing Act, the FCRA, state tenant-
landlord law, tax law, and consumer protection law" — and
"any dispute between you and a Tenant, Landlord, PM Company,
manager, or other counterparty."

**Problem.** Applied to a residential tenant, this could be
read to force the tenant to indemnify GAM for:
- The **landlord's** FCRA violations on a screening report
  the tenant didn't authorize
- The **landlord's** Fair Housing Act violations
- GAM's own statutory violations (the "violation of any
  applicable law" sweeps to include GAM if a tenant claim
  arises from that)

This breaks in several states.

**State analysis:**
- **California** — Cal. Civ. Code § 1668 voids any
  indemnification of one's own fraud, willful injury, or
  statutory violation. § 1953(a) voids tenant waiver of
  procedural rights in lease litigation; a SaaS ToS sitting
  alongside the lease relationship is at minimum at risk by
  analogy.
- **New York** — NY GOL § 5-321 voids residential-lease
  provisions exempting lessors from liability for their own
  negligence; courts may apply by analogy when the SaaS sits
  inside the rent rail.
- **Massachusetts** — G.L. c. 186, § 15 voids any
  residential-lease provision indemnifying the lessor for the
  lessor's own negligence. Same analogy risk.
- **Oregon** — ORS 90.245(1) voids any provision of a
  residential rental agreement waiving statutory rights of
  the tenant.
- **New Jersey** — TCCWNA (N.J.S.A. 56:12-14 et seq.) imposes
  per-violation statutory damages ($100 + actual damages +
  fees) for any consumer-contract provision that violates "a
  clearly established legal right of a consumer."

**Proposed copy fix.** Re-scope tenant indemnification to the
user's own breach:

> *"You agree to indemnify GAM only for claims, damages, or
> losses arising from: (i) your User Content; (ii) your
> breach of these Terms; (iii) your violation of applicable
> law; or (iv) your infringement of any third party's
> intellectual property or privacy rights. You are not
> obligated to indemnify GAM for GAM's own acts or omissions,
> for the acts or omissions of any other User, or for any
> claim arising from a statutory violation by GAM."*

Keep the broad indemnification in the **business** version
of the ToS — landlords and PM companies indemnifying GAM for
landlord-side FCRA / Fair Housing / state landlord-tenant
violations is defensible and important.

---

### Risk 5 — Delaware choice-of-law + Wilmington venue against tenants (Section 20)

**Current language.** § 20: *"These Terms are governed by
the laws of the State of Delaware… the state and federal
courts located in Wilmington, Delaware have exclusive
jurisdiction over any Dispute not subject to arbitration."*

**Problem.** A California resident tenant renting an Arizona
apartment — or any consumer-tenant in a non-Delaware state —
faces a CA / NJ / NY / MA / OR court likely **refusing to
enforce** Delaware law + Wilmington venue when applied to
displace mandatory state consumer / tenant protections.

**State analysis:**
- **California** — *America Online, Inc. v. Superior Court*,
  90 Cal.App.4th 1 (2001), refused to enforce a Virginia
  choice-of-law / forum clause against California consumers
  because Virginia didn't allow class actions and CLRA rights
  were non-waivable. Same vulnerability here: Delaware seat
  + Wilmington venue applied to deny CLRA, UCL, or McGill
  public-injunctive access to a CA tenant is unlikely to be
  enforced.
- **Massachusetts** — Ch 93A is non-waivable; a Delaware
  clause displacing 93A is unlikely to be enforced against
  consumers.
- **New Jersey** — CFA and TCCWNA non-waivable; *Param
  Petroleum* line gets attached.
- **New York** — Gen. Oblig. Law § 5-1401/5-1402 conclusively
  enforces Delaware/NY chosen law, but only for contracts ≥
  $250,000 — doesn't apply to consumer ToS. *Bremen*-style
  public-policy carve-out survives.
- **Oregon** — ORS 90.245(1) anti-waiver applies to
  residential rentals.

**Proposed copy fix.** Add a consumer savings clause:

> *"For consumer users (Tenants), Delaware law governs except
> to the extent the consumer's state of residence provides
> non-waivable consumer or tenant-protection rights; those
> rights apply. Venue for any consumer dispute not subject to
> arbitration may be brought in the consumer's home county or
> in Wilmington, Delaware, at the consumer's election.
> Individual arbitration of consumer disputes shall be seated
> in the consumer's home state at the consumer's election."*

Keep aggressive Delaware-law + Wilmington venue on the
business side.

---

### Risk 6 — Disclaimer of platform-surfaced data accuracy (Section 15)

**Current language.** § 15: *"THE PLATFORM SURFACES
INFORMATION (INCLUDING DEPOSIT INTEREST RATES, TAX FORM
DEADLINES, AND OTHER STATE-SPECIFIC DATA) FOR YOUR
CONVENIENCE. GAM USES REASONABLE EFFORTS TO KEEP THIS
INFORMATION CURRENT, BUT MAKES NO WARRANTY THAT IT IS
COMPLETE, ACCURATE, OR UP-TO-DATE…"*

**Problem.** The deposit-interest-rate and state-tax-form
catalogs are core differentiated features GAM sells to
landlords. If a CA landlord relies on a wrong deposit-interest
display and underpays a CA tenant who sues, the disclaimer
will **not** preclude a UCL claim (Cal. Bus. & Prof. Code
§ 17200) against GAM for the deceptive display. Same dynamic
under NJ CFA, MA Ch 93A § 2, NY GBL § 349.

You can't disclaim affirmative representations of fact under
state consumer-protection statutes — those statutes treat the
disclaimer as moot if the representation is misleading.

**Proposed copy fix.** Don't wholesale-disclaim accuracy of
the data tables — that's the actual feature value AND the
disclaimer doesn't work against consumer-protection claims
anyway. Switch to a good-faith caveat:

> *"GAM publishes state deposit interest rates and state tax
> form deadlines based on its good-faith reading of the
> applicable statute, regulation, or published guidance as of
> the effective_year reflected in the Platform. GAM does not
> provide legal advice. Landlords remain responsible for
> compliance with the law of each property's state and should
> verify with counsel before relying on any displayed rate or
> deadline for a regulated filing or payment."*

This preserves UCL/93A defensibility (no false statement;
good-faith caveat plus explicit "verify with counsel" notice)
without the disclaim-everything posture that simply doesn't
hold up.

---

### Risk 7 — Unilateral material changes via continued use (Section 22)

**Current language.** § 22: *"GAM may revise these Terms
from time to time. We will notify you of material changes by
email to the address on file and by in-platform notification
at least 30 days before the changes take effect… Your
continued use of the Platform after the effective date of
the change constitutes your acceptance of the revised
Terms."*

**Problem.** *Badie v. Bank of America*, 67 Cal.App.4th 779
(1998) — a unilateral change-of-terms clause **cannot** be
used to add a previously-unagreed-to category of obligation
(in Badie, an arbitration clause). 30-day notice + continued
use is solid for non-material updates but vulnerable for
material new obligations (changes to arbitration, class
waiver, liability cap, indemnification, fees, choice-of-law).

**Proposed copy fix.** Define material vs non-material and
gate material changes behind click-through re-acceptance:

> *"For non-material updates (clarifications, typo fixes,
> adjustments not affecting your rights or obligations), 30-
> day notice plus continued use constitutes acceptance. For
> **material changes** — changes to the dispute-resolution
> provisions, class-action waiver, limitation of liability,
> indemnification, fees, choice-of-law, or any other change
> that materially affects your rights or obligations — GAM
> will require you to affirmatively click through to accept
> the revised Terms; continued use without re-acceptance is
> not acceptance."*

Bonus: the database already has `user_legal_acceptance`
(migration `20260515110000`); the re-acceptance gate slots
directly into that infrastructure.

---

## Other items flagged but not in Top 7

- **Auto-renewal disclosures** for FlexPay (tenant-paid
  subscription tier). Cal. ARL (Bus. & Prof. Code § 17600
  et seq.), NY GBL § 527-a, MA G.L. c. 93 § 113, NJ
  N.J.S.A. 56:12-14.1, OR ORS 646A.295 each have specific
  clear-and-conspicuous disclosure + easy-cancel
  requirements for consumer auto-renewing subscriptions.
  If FlexPay auto-renews against the consumer, those
  layered disclosures need their own compliance pass.
  Separate from the ToS but adjacent.

- **Surviving provisions** (§ 21) — generally fine; the
  question of what survives termination of arbitration,
  liability cap, indemnification, governing law is
  uncontroversial in all target states.

- **30-day opt-out** (§ 19.5) — a positive enforceability
  factor; helps under unconscionability analysis in every
  target state. Keep this.

- **AAA Consumer Arbitration Rules** incorporation —
  appropriate choice (vs Commercial Rules) for consumer
  disputes. Keep this for the tenant side; could shift the
  business side to AAA Commercial Rules.

---

## Implementation order if you act on this

1. **Decide the structural split.** Two-track ToS
   (Business + Consumer) is the single highest-leverage
   change. Everything below collapses if this happens.
2. **Apply Risk 1 fix** (non-zero floor + willful-conduct
   carve-outs on liability cap). Highest severity; lowest
   work.
3. **Apply Risk 2 fix** (McGill carve-out, Atalese recital,
   drop § 19.4 blow-up trigger). High severity for any CA
   tenant claim; moderate work.
4. **Apply Risk 4 fix** (re-scope tenant indemnification to
   user's own breach). High severity but easier under the
   structural split.
5. **Apply Risk 5 fix** (consumer choice-of-law savings
   clause + home-state seat for individual arbitration).
6. **Apply Risk 6 fix** (rewrite data-disclaimer as
   good-faith caveat).
7. **Apply Risk 7 fix** (material-change re-acceptance
   gate; wire into existing `user_legal_acceptance` table).
8. **Auto-renewal disclosures audit** for FlexPay
   subscription.
9. **Final pass by counsel** before public launch.

---

## Sources referenced

Cases:
- *McGill v. Citibank*, 2 Cal.5th 945 (2017)
- *Atalese v. U.S. Legal Services Group*, 219 N.J. 430 (2014)
- *Henry Schein, Inc. v. Archer & White Sales*, 586 U.S. 63 (2019)
- *Coinbase, Inc. v. Suski*, 602 U.S. 143 (2024)
- *AT&T Mobility v. Concepcion*, 563 U.S. 333 (2011)
- *Am. Express v. Italian Colors Restaurant*, 570 U.S. 228 (2013)
- *Lamps Plus, Inc. v. Varela*, 587 U.S. 213 (2019)
- *Atlantic Marine Constr. v. U.S. Dist. Court*, 571 U.S. 49 (2013)
- *Kalisch-Jarcho v. City of New York*, 58 N.Y.2d 377 (1983)
- *Brower v. Gateway 2000*, 246 A.D.2d 246 (1st Dep't 1998)
- *Feeney v. Dell Inc.*, 454 Mass. 192 (2009) and 465 Mass. 470 (2013)
- *H1 Lincoln v. South Washington Street*, 489 Mass. 1 (2022)
- *Muhammad v. County Bank of Rehoboth Beach*, 189 N.J. 1 (2006)
- *Pace v. Hamilton Cove*, 258 N.J. 82 (2024)
- *Badie v. Bank of America*, 67 Cal.App.4th 779 (1998)
- *Douglas v. U.S. Dist. Court*, 495 F.3d 1062 (9th Cir. 2007)
- *Maxwell v. Fidelity Financial Services*, 184 Ariz. 82 (1995)
- *America Online v. Superior Court*, 90 Cal.App.4th 1 (2001)
- *Blair v. Rent-A-Center*, 928 F.3d 819 (9th Cir. 2019)

Statutes:
- A.R.S. § 12-1501 (AZ arbitration)
- Cal. Civ. Code §§ 1668, 1670.5, 1750 et seq. (CLRA), 1751, 1953, 3513
- Cal. Bus. & Prof. Code §§ 17200 (UCL), 17500 (FAL), 17600 et seq. (ARL)
- N.Y. Gen. Oblig. Law §§ 5-321, 5-1401, 5-1402; N.Y. GBL §§ 349, 350, 527-a
- M.G.L. c. 93A; c. 186 § 15; c. 93 § 113
- N.J.S.A. §§ 56:8-1 et seq. (CFA), 56:12-14 et seq. (TCCWNA), 56:12-14.1
- ORS §§ 90.245, 646.605 et seq. (UTPA), 646.638, 646A.295, 72.3020
- 9 U.S.C. §§ 1 et seq. (FAA)

---

**End of pre-lawyer pass.** This memo identifies the highest-
risk gaps and proposes concrete copy fixes. Apply at your own
risk, and **engage qualified counsel licensed in each target
jurisdiction before public launch** — particularly for the
consumer-tenant track, where the McGill / Atalese / Feeney
exposure warrants a multi-state class-action specialist's
review.
