# Deposit Custody Playbook (S604)

One page for the whole deposit-custody question. Supersedes the scattered notes
in LAUNCH.md. Source of truth for the data is the DB:
`state_deposit_interest_rates` (what is OWED) and `state_deposit_custody_rules`
(where the money may SIT).

---

## 1. The model

**Earn on every held deposit. Pay only where a state and unit type require it,
and only the required amount. The spread is GAM's.**

- Earning is never conditioned on a statute — if GAM custodies the dollar, it earns.
- A state with no obligation is the BEST case, not a bad one: full spread to GAM.
- Spread is tracked signed. Only three obligations can run negative against
  market yield: **AZ mobile home 5%**, **RI mobile home 3%**, **OH 5%**.

All 50 states have been read, per (state, ACT) — Arizona alone has four tenancy
acts and they disagree with each other.

---

## 2. Vehicle decision — how many states each option opens

| Vehicle | States | Notes |
|---|---|---|
| Treasury bills as-is (brokerage) | **26** | No account requirement in these states at all |
| \+ per-tenant bank accounts ("pocket accounts") | **41** | Adds the 15 whose only test is the INSTITUTION |
| Remaining restricted | **9** | CT DE FL MA NH NJ NY OK WA |

**Why T-bills alone fail in 21 states:** those statutes require two things
together — a federally insured/regulated *institution*, AND the money sitting in
a deposit/escrow/trust *account* there. A T-bill is a security, not a deposit,
and a broker-dealer is not an insured depository. Treasuries are stronger credit
than FDIC insurance; they are not FDIC insurance, and the statutes test the
latter.

**Why pocket accounts fix 15 of them:** a per-tenant account at an FDIC-insured
national bank satisfies both tests, and it is the exact shape the statutes
contemplate (a trust/escrow account per tenant). It also solves Colorado, whose
requirement is the opposite of pooling — CO demands a *separate* trust account
per deposit with no commingling.

---

## 3. The 9 remaining states — what each actually needs

| State | Blocker | What would fix it |
|---|---|---|
| **CT** | Bank "located in this state" (§ 47a-21 defines it) | CT-located bank account. No bond option. |
| **DE** | "office that accepts deposits within the State" (§ 5514) | DE bank account. **No landlord bond exists** — the bond in § 5514 is a TENANT-side substitute for the deposit itself. |
| **FL** | "Florida financial institution" (§ 83.49) | Best: FL interest-bearing account, elect the **75% of actual** option → keeps 25%, structurally positive. Or bond with the clerk + 5% simple to tenant (above market, runs negative). |
| **MA** | "bank located within the commonwealth", separate + interest-bearing (§ 15B) | MA bank account. Interest is lesser-of 5%-or-actual, so it can never run negative. |
| **NH** | Institution "organized under the laws of this state" (§ 540-A:6) | NH-**chartered** institution. A national charter fails. Pooling ACROSS TENANTS is expressly allowed. |
| **NJ** | 10+ units: MMF from an investment company "based in this State"; under 10: insured NJ bank (§ 46:8-19) | NJ-based MMF or NJ bank. Owes actual-earned (whole yield to tenant), so spread is zero either way — **low priority**. |
| **NY** | In-state banking organization — but **only for 6-or-more-family dwellings** (§ 7-103) | Under 6 units: trust duty only, no institution named → likely already fine. 6+: NY bank. |
| **OK** | Escrow "maintained in the State of Oklahoma", federally insured (§ 115) | OK bank account. **Misappropriation is criminal** — treat as strict. |
| **WA** | Trust account at an institution or escrow agent "located in Washington" (§ 59.18.270) | WA bank account. |

### Which of the nine are worth pursuing

Unlocking a state is only worth the spread it produces. Three of the nine hand
the ENTIRE yield to the tenant by statute — they are worth nothing at any scale.

| Priority | State | Spread if unlocked | Why |
|---|---|---|---|
| 1 | **WA** | **full** | Owes nothing, real rental market. Best of the nine. |
| 2 | **FL** | 25% | Owes 75% of actual, but a huge market; bond route exists. |
| 3 | **OK** | **full** | Owes nothing; smaller market, criminal-liability statute. |
| 4 | **DE** | **full** | Owes nothing; very small market. |
| 5 | CT | partial | Index-linked; spread depends on the CT deposit index vs market. |
| 6 | NY | ~1% | Only 6+ family units are restricted; smaller NY already works. |
| — | **MA** | **ZERO** | Lesser-of 5%-or-actual → owed always equals earned. |
| — | **NH** | **ZERO** | Actual-earned → whole yield passes through. |
| — | **NJ** | **ZERO** | Actual-earned → whole yield passes through. |

**Never pursue MA, NH or NJ for custody.** You could stand up in-state banking
in all three and earn exactly $0 — the statute takes the entire yield.

**Bonds do not solve these nine.** Bond alternatives exist in exactly four
states — **MI, GA, FL, NC** — and three of those are already solved by pocket
accounts. The only bond that buys anything new is Florida's, at 5% to the tenant.

**Bond shape (important):** the statutes name **the landlord as principal**, not
GAM. Florida and Georgia require filing with the **clerk of court in the county
where the unit is located**, capped at the deposits held **or $50,000, whichever
is less**. So it is one bond per landlord per county — administratively worse
than pocket accounts. Michigan is the exception: filed once with the secretary
of state, and it is the only state that expressly lets the landlord then "use
the moneys so deposited for any purposes he desires".

**Fallback for all nine:** `held_by='landlord'` — already in the schema. The
landlord keeps the deposit and the compliance duty; GAM does the accounting and
earns nothing. Zero risk, zero yield, no new law to satisfy.

---

## 4. Questions for Jiko (Wednesday)

**Blocking — ask first:**
1. Can a pocket account be titled FBO the tenant, KYC'd, but with **withdrawal
   authority restricted to GAM**? If the tenant can pull funds directly, the
   landlord loses the ability to claim against the deposit for damages, and the
   product is unusable regardless of how well it fits the statutes.
2. Is the entity holding the pocket account an **FDIC-insured, nationally
   chartered bank**? Deposit insurance and federal regulation are the exact
   statutory tests in the 15 states this unlocks.
3. Does the money sit as a **bank deposit** with Treasuries as a sweep, or as a
   **securities position** in a brokerage account? This is the single question
   that decides whether ~15 states qualify. A T-bill position alone does not
   satisfy a "deposit account at an insured institution" requirement.

**Economics:**
4. Per-account fee structure — flat, tiered, or basis points? At $350–1,800 per
   deposit, a flat per-account fee could exceed the yield on a small deposit.
5. Their cut of the yield (the 3.5% placeholder in the DB assumes a spread taken
   somewhere; needs the real number).
6. Minimum balance per account, and behaviour on very small balances.

**Coverage:**
7. Do they have bank partnerships or chartered presence in **CT, DE, FL, MA, NY,
   OK, WA** (physical-office states) or **NH, NJ** (state-charter states)? Any
   of these moves the count above 41.
8. Can accounts be opened/closed programmatically via API at tenant move-in and
   move-out, and how fast is disbursement? Several states require return within
   **14 days** (AZ), so settlement speed is a hard constraint.

**Operational:**
9. Who performs KYC, and what happens if a tenant fails it — can the deposit
   still be held?
10. Reporting: per-account interest statements. Several states require interest
    paid or credited **annually** (NJ, OH, IL, RI, PA, NY), and interest is
    taxable income to the tenant (1099-INT).

---

## 5. Open questions for counsel

1. **Does a Treasury position at a broker-dealer satisfy "a trust account" in
   IA / KS?** Both expressly permit a *common* (pooled) trust account with no
   institution or geography requirement — the most favourable wording found
   anywhere. If yes, those two move to supported immediately.
2. **Custody agreement allocation:** where a statute obligates *the landlord* to
   pay interest above market (AZ mobile home 5%, RI 3%, OH 5%), can GAM's
   custody agreement place the top-up on the landlord? Standing rule is GAM
   never absorbs.
3. **Is the landlord-collateral idea (below) deposit-taking?**

---

## 6. Landlord-funded collateral (Nic's idea) — verdict

*"The landlord keeps all security deposits; the landlord separately funds their
own deposit to GAM in exchange for reduced platform fees."*

This is cleaner than routing tenant deposits through GAM — it is the landlord's
**own corporate money**, so none of the 50-state tenant-deposit custody law
applies. But the structure matters enormously:

- **Refundable, GAM invests it, GAM owes it back** → that is borrowing from
  landlords. Presumptively a security (a note under *Reves*), and arguably
  deposit-taking. Also breaks the standing "no debt, no outside money" rule for
  funding the float.
- **Non-refundable prepayment of platform fees** → ordinary prepaid revenue.
  Completely fine, but it is revenue, not float — GAM cannot count it as a
  deposit pool it earns a spread on, because it is already GAM's money.
- **Refundable collateral securing the landlord's own obligations to GAM** →
  ordinary B2B commerce, the most defensible middle ground. Still money GAM owes
  back, so it does not escape the question entirely.

Recommend counsel review before designing around it. The tenant-deposit path
(pocket accounts) has a known, mapped answer in 41 states; this path trades that
for an unmapped federal question.
