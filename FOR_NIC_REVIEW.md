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

### 1. The refund button — corrected, and the gap is smaller than I thought

**Your correction is in.** The halfway point now decides **only** whether the
final utility is a wash. It no longer decides whether money can go back. The
figure to refund is worked out and offered **whatever** the halfway point says —
including on a departure that washes — because it is a situational call for
whoever is at the desk, not a rule.

A property that gives nothing back still washes however early they left (your
10/18 setting), and a month nobody paid has nothing to give back. Those are the
only two reasons the offer is withheld, and each says so on screen.

**I also stopped the halfway point gating the bill adjustment**, for the same
reason — an unpaid month is the same money question with the cash still on
their side of the table. The screen says how much of the month they used and
the person decides. Say so if you want that one gated after all.

**And the button mostly exists already.** Looking for where to put it I found
`paidAheadChoice` — built 10/4, decisions #46.1: for paid-ahead money on an
ended lease, somebody with "Issue refunds" gets exactly three choices — *No
refund*, *Refund the unused days*, *Refund a different amount* — and the money
goes back the way it was paid, card to that card, bank to that bank, with the
card fee returned to the tenant and Stripe's fee shown as the landlord's cost
before they confirm.

So I am not building a second refund path. **The one real gap:** that screen
only has something to offer when the unused rent has been banked as paid-ahead
money, and the code that banks it runs when a **booking's** dates move. A plain
lease — RV 20 and RV 41 have no booking — whose move-out date lands mid-month
never banks the unused part, so the button has nothing to show.

**The work, for the morning:** when a lease's move-out date is set and rent is
paid past it, bank the remainder as paid-ahead money the same way a shortened
stay does, and make sure "the unused days" means what the departure rule says it
means (monthly ÷ days in that month for a resident, the register's ladder with
tax for a genuine first month). One hook, and one figure reconciled between two
modules so they can never disagree.

I stopped there rather than half-build a path that moves money.

### 2. One call I made on the adjustment, worth a yes or no

Where somebody **never paid** the month and left early, pressing
**"Save and adjust the bill to $X"** does both things at once: sets the move-out
day and re-prices the bill, dropping the late fees.

A late fee that **money is recorded against** is left alone, and the screen says
so. I would rather tell you a fee stayed than quietly tear it out from under a
receipt or a bank match.

### 3. The PM fold — where it actually stands

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

## The portfolio toggle, since you asked

Right now you switch between one property and the whole portfolio. Once a
management company is just another company on your account, that control wants
**one more level above the properties, not a second toggle**:

```
Everything I own          ← roll-up across the companies you own
  Oak Park Motel and RV
  Mountain View RV Ranch
Everything I manage       ← roll-up across companies you manage for others
  Smith Family Trust  (managed)
    their two parks
  Baker Holdings LLC  (managed)
    their park
```

One picker, three depths: a roll-up, a company, a property. Not a separate
"owned vs managed" switch, because you already have a picker that names the
company and a second control doing the same job in a different place is the
thing that makes other software need a workaround. It also keeps your own rule
intact — nothing is ever a default, and with two or more it starts on "Choose a
company…".

The two roll-ups are worth having as real entries rather than a filter: "what
did I earn" and "what did I earn managing" are different questions, and a
manager's cut is a different line from an owner's rent.

---

**Say the word and I will deploy.** I held it because you opened new items after
the go-ahead, and nothing you need today is waiting on it.
