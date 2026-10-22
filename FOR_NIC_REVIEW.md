# For Nic — 10/22, while you were out

Everything below is **built, tested and pushed. Nothing is deployed.** The live
site is still on this morning's build, which is correct for the two checkouts
you needed.

---

## You can do this right now, on the deployed build

**Check out RV 20 and RV 41 as of Oct 20.** Master schedule → click their lease
bar → "They gave notice" → pick **Oct 20** → Save, then take the closing read at
the register.

Verified against your live rows, read-only: **$228.00 kept each, lodging tax
$0.00**, final electric billed to nobody. 19 of October's 31 nights used.

---

## Three things I need you to look at

### 1. The refund for an early departure is a figure, not a button yet

When somebody leaves in the **first half** of a month they already **paid** for,
the rule now says money goes back. GAM works out exactly how much and shows it,
but sending it is still a manual refund from their Payments page.

The machinery to send it exists (it is what refunds a stay's early check-out —
retries, "try again", bank-turned-it-down wording). Hooking a lease departure
into it is the next real piece of work. **I did not want to half-build a path
that moves money while you were out.**

Everything else in that flow is done: the halfway fork, the resident-vs-tourist
re-pricing, the tax inside the total, the bill adjustment when they never paid.

### 2. One call I made on the adjustment, worth a yes or no

Where somebody **never paid** the month and left early, pressing
**"Save and adjust the bill to $X"** does both things at once: sets the move-out
day and re-prices the bill, dropping the late fees.

A late fee that **money is recorded against** is left alone, and the screen says
so. I would rather tell you a fee stayed than quietly tear it out from under a
receipt or a bank match.

### 3. The PM fold is two steps in, four to go

Done, and safe to leave sitting:

- A company can be **managed**, not only owned.
- A worker's property scope **and** permissions now belong to the company that
  granted them. This fixed a real fault: anybody working for two owners used to
  get whichever grant came back first from the database.

Still to do (`PM_FOLD_PLAN.md` has the full plan and the inventory of all 13
pages so nothing is lost):

- Sub-delegation — a PM owner adding their own staff, capped by what the owner
  granted the PM company.
- A guard test that every landlord-portal route respects a manager's scope.
  **Today only 15 of 108 route files check it by hand.** This is the piece that
  makes folding safe rather than hopeful, and I would do it before moving any
  pages across.
- Moving the four PM-only pages (owners + statements, fee plans, staff,
  banking) under a Management section.
- Retiring pm.goldassetmanagement.com.

Both PM companies on the platform are June demo rows with no bank account, so
there is no real data to carry.

---

## Done today, all tested

| | |
|---|---|
| **No test is a gamble** | 26 assertions across the suite searched stringified payloads for bare digits — each a coin flip against a random id. One rule now, proven against 20,000 ids, plus a guard that fails the suite if anyone writes that shape again. |
| **Left-owing matcher** | Name + email or name + phone, nicknames and shortenings, close calls to a new **Left-Owing Matches** admin page where nobody is flagged until a person decides. |
| **The halfway fork** | Half the month used → wash. Less → pro-rate. |
| **Resident ≠ tourist** | Short-term lodging tax never lands on somebody who has been there more than a month, whatever their lease's start date says. |
| **The bill adjustment** | $589 → $152 for eight nights, late fees voided, refusals in plain words. |
| **Any leaving day** | Past or future. A Sunday departure settled on Monday is recorded as Sunday. |
| **Managed companies** | One login, several companies, scope and permissions per company. |

Full API suite **15,648 green**. Landlord portal **1,331 green**.

**Say the word and I will deploy.** I held it because you opened new items after
the go-ahead, and nothing you need today is waiting on it.
