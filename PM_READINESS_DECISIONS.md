# What a real property management company would expect — and what we have

For Nic, morning of 10/31. Five areas surveyed: insurance, vendors, maintenance
as a PM runs it, owner-side money, and compliance.

**Read this first.** The survey was done by five agents reading the code. I then
checked the biggest claims against the live database myself, and **four of them
were wrong or overstated.** Those corrections are marked ✅ below. Where I did
not personally verify something, it says so. Nothing here should be repeated to
a prospect until the line you care about has been checked.

---

## The one thing that changes everything

**A large amount of the management-company subsystem was built as a data model
and never connected to any code.**

These exist in the live database today: management companies, fee plans, monthly
fee accruals, staff, owner relationships, property invitations. There is even a
migration from September named *"the manager already has a price list."*

Every one of them is empty, and **the only files that mention them are the
migrations that created them.** No application code reads or writes any of it.

That is very different from "not built." The hard thinking — what a fee plan
is, how an accrual records, how an owner relationship is shaped — is already
done and in the schema. What is missing is the wiring and the screens.

**So when you see "medium" below, read it as connecting existing plumbing, not
inventing it.** I'd want a proper estimate before promising dates, but this is
the single biggest thing on the page and it reframes most of the rest.

---

## Decide first

### 1. Insurance — the resident table exists and nothing uses it
✅ *Corrected.* The survey said nothing could be recorded for anyone. Not true: a
resident liability-policy record exists with carrier, policy number, expiry date,
a document and notes, tied to a lease. It has **zero rows** and **no screen** —
no portal page reads or writes it. The lease parser is the only live code aware
of it.

Still genuinely missing: **vendor** insurance and the **building's own** policy
have no home at all.

Without it you cannot answer "is this resident insured," "is my plumber insured,"
or "when does this building's coverage renew" — and there is no lapse list,
which is the whole point.

**Size:** small for residents (the table is waiting, it needs a screen).
Medium for vendors and buildings.

### 2. A job cannot be sent to an outside vendor
Maintenance work can only be assigned inside the company. There are vendor
records, but on the bookkeeping and register side — for paying them, not for
dispatching them.

Without it, dispatch, acceptance, the vendor's photos and their invoice all
happen by phone and get typed back in. It also means there is no moment where
the platform could refuse to send an uninsured contractor to someone else's
property — which is the real reason this and insurance belong together.

**Size:** medium. *I did not personally verify this one against the database.*

### 3. The management company cannot charge what it priced
✅ **BUILT — this note was stale and was re-checked against the code on 10/31.**
`jobs/monthlyFeeAccrual.ts` reads `pm_fee_plans` and writes
`pm_monthly_fee_accruals`; `services/allocation.ts` routes the company's cut out
of rent as it is allocated; `services/ownerStatement.ts` reads the accruals onto
the owner's statement. A company can sign an owner and be paid. There are zero
rows in either table on `gam`, which means nobody has set a fee plan up yet, not
that nothing computes one.

**What is still true, and is now the whole of this item:** two of the seven fee
types a plan may be given — `leasing_fee` and `maintenance_markup_pct` — are
stored and never computed. `services/allocation.ts` says so in a comment: they
"fire on different triggers and are no-ops here", and no other trigger was ever
written. So a company that prices its work either of those two ways collects
nothing, silently, which is the bad half of the original note surviving in a
much smaller place.

**Size:** small. Two fee types need the event that fires them — a lease signed,
and a maintenance job closed with a cost.

### 4. An owner has no way to receive a statement
The statement is computed correctly and completely. There is no owner-facing
screen, no PDF, no email, and no monthly send. The survey also reports that two
of three money columns read as a dash on the manager's own statement screen
because it asks for the wrong figures — *I have not verified that specific bug.*

Without it, the thing an 11,000-unit company's owners expect in their inbox on
the same day each month exists only as data nobody outside can see.

**Size:** small to medium.

### 5. Evictions have nowhere to live
✅ *Corrected.* The survey implied nothing exists. There **is** a real eviction
mode: a per-unit switch, with its own permission, that hard-blocks payments,
shows on your dashboard and flows into tenant payment reports.

What does not exist is the **case**: notice served, filing, hearing, court or
case number, possession date, attorney cost. No lease-violation record either —
no noise complaint, unauthorized occupant, pet, or notice to cure, and no
repeat-offender list.

So the switch is built; the paper trail is not. Confirmed directly: there is no
eviction or violation table in the database.

**Size:** large.

### 6. A management company can only have one person in it
✅ *Partly corrected.* A staff table exists and is empty and unwired, same as the
rest of the subsystem. The permission engine behind it — a manager's tech and
front desk scoped and capped by what the property's owner granted — is
genuinely finished.

Effect stands: a company with more than one employee cannot use the management
side.

**Size:** medium.

---

## Expected, not urgent

Highest-value first. I have not individually verified these.

- Certificates and W-9s are tick boxes with no document behind them, and nothing
  warns before one expires.
- No approved or preferred vendor list; trade names are free text that do not
  match work-order categories.
- No license numbers — trade, brokerage, or individual manager. First thing an
  owner's diligence asks for.
- The owner engagement is a clicked link with no signed management agreement
  behind it: no term, no notice period, no termination clause.
- Statements are one calendar month only — no year-to-date, no annual, no
  year-end tax form to owners.
- The statement reads as earnings, not cash: no opening balance, no
  distributions, no closing balance, so an owner cannot tie it to their bank.
- No owner reserve or float, so a manager fronting a plumber spends their own
  money until the next cycle.
- No budgets, so no budget-versus-actual conversation with an owner.
- Any bill can be charged to an owner with no sign-off and no receipt.
- A repair the resident caused always lands on the owner — it cannot be billed
  back from the work order.
- Work orders have no readable job number, no due date, no parts-and-labor
  split; clocked hours never become a labor cost.
- Common-area work — clubhouse, pool, roads, office, lighting — has nowhere to
  go, because every job must hang off a unit.
- Preventive maintenance only rolls a date forward: no job, no cost, no history.
- Findings from a unit walk can be charged to a resident but cannot become work.
- No turn board between tenancies, so the vacancy clock is unmanaged.
- No dispatch calendar for techs. The scheduling engine exists on the register
  side and cannot see a property.
- No appliance register with serial and warranty dates, so warranty work gets
  paid for twice.
- The full change history exists — tens of thousands of entries — with no screen,
  so "who changed this rent" needs someone querying live data.
- No written, versioned screening criteria on file — the standard defense when a
  denial is questioned.
- **No Equal Housing notice on public listings. Cheapest item on this page.**
- No clock on the state deadline for returning a deposit.
- Consumer reports are kept forever. This is the one place the law wants the
  opposite, and the switch for it was reportedly built and left unwired.

Already decided, not an oversight: a vendor login stays deferred until the
management deal tells us how their vendors actually work.

---

## What is genuinely strong

Worth holding in view, because the list above is long and the foundation is not
the problem.

- **Money handling is better than industry standard.** Every dollar is split at
  the moment it is paid and each party is paid into their own account — nothing
  is ever pooled. Every money table carries a full change journal, closed
  accounting periods are locked against edits, and the owner's share is a real
  recorded row, not a figure derived later.
- **The owner statement itself is deep and correct** — platform money separated
  from money the manager took directly, reversals beside gross, billed versus
  collected, fee, expenses, net, portfolio totals. Owners can compare managers
  on occupancy, on-time payment and days to fill.
- **Management fees are modeled in seven shapes**, including the one-time leasing
  fee, paid into the management company's own account.
- Inspections, screening compliance, and the in-house maintenance crew tools are
  real and working.

---

## Open question for you

**pm-company portal.** You said it folded into the landlord portal, but it is
still in the codebase and **still deploying** to pm.goldassetmanagement.com —
tonight's deploy reported it in sync. Either the fold-in is unfinished or that
is live dead weight. I have not touched it. Tell me which and I'll act.
