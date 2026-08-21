# SESSION 610 HANDOFF

Written at the end of S609. The two money builds the S608 handoff reserved for
fresh context — **tenant autopay** and **pay-ahead** — are both built and tested.
Nothing is deployed yet.

---

## 0a. DAY TWO — TEST SUITE GREEN, TWO BUGS FOUND

**The whole suite passes: 288 files, 4,799 tests, zero failures.** It was 20
failing when the day started (out of ~4,700 — not "19 of 20"; Nic read the
summary line as a ratio, understandably).

Nic's rule, and the right one: *"Every test should be passing. If it's not
passing, we either change the code or change the test."* Each of the 19 was
judged on which side was actually wrong, rather than bending the test to match
whatever the code happened to do:

- **Six described behaviour we deliberately changed** — unit numbering ("Lot 8"
  is now "MH 08"), a co-owner invite that replaced a dead end, a booking deposit
  menu, a renamed checklist label, an added onboarding to-do, a new import
  warning. Tests updated to pin the *current* rule, not deleted — a rule nobody
  guards is a rule that quietly regresses.
- **Two had rotted on the calendar.** They hardcoded 2026 dates against rolling
  windows ("last 60 days"), so they passed when written and failed once time
  moved past them. Re-anchored to "now" so they can't rot again.
- **Two were REAL BUGS** (§7).
- The rest were stale stand-in data for Stripe, and one guard doing its job.

## 0b. THE INTERMITTENT WHITE SCREEN — FOUND AND FIXED

Nic: *"Minified React error #310... that error happened two different times...
it happened one time before your recent edits."*

He was right that it predated the day's work, and that detail is what solved it.

**Cause:** the property page ran three data hooks, then stopped early to show
"Loading…", and declared a fourth hook *below* that stop. On a cold load the
first pass ran three hooks and the next ran four; React refuses when the count
grows, and the page died. With the data already cached there is no loading pass,
the counts match, and it works — which is why it looked random and "went away".

It only bit on a hard reload or a first visit of the day. Which is exactly when a
landlord opens the app.

**Fixed**, and now guarded: `npm run lint:hooks` checks all twelve front-ends for
this specific mistake and currently reports zero. That check is the only reliable
way to catch it — it is invisible to typechecking and to every test we have.

## 0c. METERS CAN BE EDITED NOW

Nic: *"I have no button to edit my first master meter that I added. I didn't
label it the way I wanted to, and there's no way to change it."*

Worse than a missing rename: **a meter was frozen the moment it was created.**
Label, base fee, split method, what the split is priced from — all set once, and
afterwards the only choices were "mark broken" or "delete". Fixing a typo meant
destroying a master and losing its unit assignments.

It also made **step 2 of §0 below impossible** — switching Oak Park's master to
the utility-bill basis and the rented-units split. There was no way to do it.

One form now does add and edit, so the two can't drift.

**Locked by USE, not by existence** (Nic corrected my first version, which froze
the utility and billing method the moment a meter was created):

> "Every feature needs to be editable on meters when there is no history. Only
> lock it once there's history, not once it's created. Somebody accidentally
> setting something up the wrong way needs to be able to change it so they don't
> have to redo potentially everything. That's gonna be a friction point during
> onboarding."

He's right — a meter that has never been read and never billed has no history to
protect, and locking at creation only made a setup typo unfixable during the
exact phase where typos happen. So EVERYTHING is editable until the meter has
actually measured or billed something. After that the utility and billing method
freeze, because changing them then would re-interpret readings already taken and
bills already sent.

Unit assignments never count as history and always survive an edit — fixing a
wrong setup must not mean redoing the assignments too.

**Oak Park's master needs exactly two changes** (verified against the live row):
priced-from → *the utility bill*, and take-submeters-out-by → *their invoiced
dollars*. Split method (occupancy) and submeter rate (published penny/gallon) are
already correct. It still has ZERO units assigned, so it bills nothing until all
19 RV spots and 8 mobile homes are linked.

---

## 0. NIC'S IMMEDIATE PATH

1. **Walk the two new screens.** Sign-in needs your emailed 2FA code, so this is
   yours to do: tenant portal → Payments. You should see an **Autopay** card and,
   when you press Pay, an **Amount** box you can type a bigger number into.
2. **Deploy when you're happy** — `bash ~/gam/deploy.sh`. Nothing is live. That
   ships the white-screen fix and the meter Edit button along with everything
   else, so it's worth doing before more setup work.
3. **Nothing is waiting on you.** Both things you raised — no cap on paying
   ahead, and late fees going to the landlord — are built and tested (§1, §6).

---

## 1. PAY AHEAD — A TENANT CAN NOW PAY MONTHS UP FRONT

Nic: *"If somebody prepays a full year ahead of time, that money sits on GAM's
books, and we disburse to the landlord each month as invoice comes due."*

That is what it does.

- The Pay screen now has an **amount box**, starting at what they owe. Paying
  what you owe is still one click — nobody who doesn't care about this has to
  think about it. Typing a bigger number pays future months.
- **Paying LESS is still refused.** That rule did not move — a partial can reset
  a landlord's eviction clock.
- The old code refused over-payment too. The comment beside it said *"no
  pay-ahead — the UI has no amount field"* — that recorded a **missing input
  box, not a decision**, which Nic confirmed.
- **NO CEILING** (Nic — he reversed the lease-term cap I first wrote, same
  session). His reasoning: *"A tenant that's getting billed utilities — they
  never know what it's gonna be until the meters are read. The last month or so
  they're not gonna have enough credit for the utilities, or they're gonna have
  paid too much and have to get credit back. So let's just not put any cap on it,
  to eliminate those pinch points."* He is right — a lease term is knowable, its
  COST is not, so any cap lands wrong at the end of every lease. The screen still
  SUGGESTS roughly what the rest of the lease comes to; it does not limit.
- The tenant sees **their credit balance at the top of the Payments page** — $10,000
  reads as $10,000 (Nic). It explains that it comes off each bill automatically
  and that anything unused comes back at move-out.

### THE DEFECT THIS FOUND — prepaid money never reached the landlord

Marking next month's bill "covered by prepaid credit" was built in S537 and it
settled the bill correctly. **It stopped there.** It never told the payout side
the landlord had earned anything, so the money stayed on GAM's books
permanently: the tenant's bill said paid, the landlord's account said nothing
arrived, and no report would ever have shown the gap.

Not theoretical — **a shortened RV stay banks prepaid money the same way today.**

Fixed. Every release now books the landlord's share exactly like a card or bank
payment and rides out on the ordinary weekly payout. `prepaidRelease.test.ts`
locks it down, including the twelve-months-paid case releasing **one** month.

### No second processing fee

The bank/card fee comes out when the tenant actually pays, on the whole amount
they hand over. Releasing a month later moves money already sitting on GAM's
balance — no bank involved, nobody charged twice. The books were also corrected
so the fee GAM records matches what Stripe actually processed on a pay-ahead
charge (it counted only the applied part before).

### The landlord does NOT see the prepaid amount (Nic)

Nic: *"I don't know if it should show the landlord that they've paid that much
ahead, because the landlord is gonna be coming after the platform saying, hey,
where's that money?"* Agreed and enforced. Checked the whole landlord portal — no
screen reads it, and the only place it is served is a tenant-only endpoint. The
landlord sees an on-time tenant every month, which is what they are.

**One deliberate exception:** at **move-out**, remaining credit appears in the
deposit-return statement, because that is when it is refunded and the numbers
have to add up. Flagging it so it is a decision, not a surprise.

---

## 2. AUTOPAY — TENANTS CAN SCHEDULE THEIR RENT

There was **no autopay of any kind** before this. Every tenant logged in and
pressed Pay Now every month. The table landed in S607; nothing charged.

- Tenant picks **the day rent is due**, or **a day 1–28**, and which account to
  pay from (or leaves it following whatever their default is at the time).
- It charges the **live balance at run time** — whatever is owed that morning,
  including a late fee that ticked overnight. **Nothing is forecast** (Nic): the
  balance moves between choosing a day and the charge landing, so any number
  promised in advance is one the system cannot keep.
- Runs **9am in the property's local time**, after late fees (local midnight) and
  invoices (local 7am), so the balance it reads is today's real one.
- It charges through **the exact same code as the Pay button**. A scheduled
  payment and a pressed button can never produce a different fee or a different
  owner share.
- **It cannot charge twice.** The month is claimed before the charge is
  attempted, so a restarted job or a second server can only lose that race.

### The pull day is the tenant's alone

Nic, DIRECTIVE: *"The landlord should not be pulling the strings on when the
money gets moved. That could be used the wrong way with a landlord pushing the
date back and getting extra late fees."*

No landlord route writes to it. The landlord gets a **read only** — an "Autopay
9th" badge on the lease row, so a quiet lease does not read as a tenant who
stopped paying. **Do not add a landlord write path.**

### On failure (Nic chose this)

Stays on, both sides told, **switches itself off after two failures in a row**.
One bad month shouldn't unschedule someone who fixed it the next day; a closed
account shouldn't cost them a bank fee every month forever. A failed autopay was
also added to the list of notifications a tenant **cannot** switch off — they
believe their rent is handled and have no reason to check.

The landlord is told a payment failed but **never the bank's error text** — that
is between the tenant and their bank.

---

## 3. NIC PULLED ME UP ON THIS — AND WAS RIGHT

> *"Why would a misconfigured property stop the tenant from getting billed at
> all? We've went through that money workflow multiple times. We even changed
> utility submetering so that if it ever becomes broken it still sends the rent
> bill and doesn't gate the invoice from going out."*

Correct, and it was **my new step that introduced the risk**, not something
pre-existing. Handing the landlord their share went inside the same transaction
that creates the bill, so a failure would have rolled the bill back with it. My
own test caught it and it was fixed before he asked — the bill always goes out,
the credit is left untouched, an alert fires, next cycle picks it up.

**His broader point found a second one.** The landlord-issued-credit step (S607,
not this session) sat in that same transaction unguarded. Same class of defect,
now guarded the same way. The landlord's own issue-a-credit button still throws
its error to the screen, because a person pressing a button needs to see it.

**Standing rule, worth stating plainly: nothing bolted onto invoice generation
may ever stop the rent bill going out.** Check this on anything added there.

---

## 4. FILES

**New:** `services/rentCharge.ts` (the one way a lease balance is charged — the
Pay button and autopay both go through it), `services/prepaidRelease.ts`,
`jobs/autopayRunner.ts`, `routes/tenantAutopay.ts`,
`apps/tenant/src/pages/AutopayCard.tsx`, plus three test files.

**Changed:** `routes/payments.ts` (charge logic lifted into the service; the
pay-ahead suggestion; GAM-fee stamps), `services/allocation.ts` (fee-free release
mode; surplus counted in the fee base; late fees and landlord fees now allocate),
`routes/webhooks.ts` (settle loop widened; decline-fee stamp),
`jobs/invoiceGeneration.ts` (release + both savepoint guards), `routes/leases.ts`
(autopay visibility), `routes/reports.ts` (GAM's fees out of the landlord's P&L),
`jobs/scheduler.ts` + `jobs/timezoneCronManager.ts` (the daily job),
`packages/shared/src/index.ts` (whose-money definitions; failed autopay can't be
silenced), `services/paymentReversal.ts` / `flexCredit.ts` / `flexDeposit.ts` /
`otp.ts` (GAM-fee stamps), tenant `payShared.tsx` / `PaymentsPage.tsx` /
`lib/api.ts`, landlord `LeasesPage.tsx`, `test/dbHelpers.ts`.

**Migrations applied** (dev `gam`, schema.sql regenerated):
`20260819210000_autopay_failure_tracking.sql`,
`20260819220000_payment_revenue_owner.sql` (whose money each charge is),
`20260819230000_carried_balance_one_per_lease.sql` (see §6).

**Tests: the full suite ends BETTER than it started.** 4,776 passing, 19 failing
— against a measured baseline of 4,666 passing and 20 failing (verified by
stashing every change and re-running the whole suite). The one that went away is
the carried-balance guard in §5. Every remaining failure fails identically
without any of this work. 30 new tests were added.

One regression was caught this way and fixed, and it mattered: opening allocation
to late fees meant a fee that could not be credited would have **rolled back the
tenant's entire payment** — rent included — because they ride the same charge.
Same shape as the invoice-gating problem Nic called out, same answer: rent and
utilities stay strict (a failure there rolls back so Stripe retries, which is the
long-standing design), while a fee that cannot be credited now settles anyway and
raises an alert. **Running only the suites that looked related would have missed
this** — the failure only appeared in the full run.

Run with
`cd apps/api && DB_NAME=gam_test npx vitest run …` — **never without DB_NAME, it
wipes the dev database.**

`s537-payment-fifo.test.ts` was updated deliberately: it asserted over-payment
was rejected, which is the rule that changed.

**Not deployed.** API + tenant + landlord all typecheck and build clean.

---

## 5. FOUND IN PASSING — A LANDLORD COULD BILL THE SAME OLD DEBT TWICE

When a landlord takes over a tenant who already owed money, they enter that
opening balance by hand. The rule is one per lease, and the code said so — but it
checked whether one existed and then created it, with nothing in between. Two
clicks on a slow connection, or a retried request, and both checks pass before
either lands. The tenant then owes an inherited debt twice, on a charge a person
typed in, with nothing to catch it.

Now enforced by the database, so it cannot happen rather than being unlikely. The
friendly "this lease already has a carried balance" message is unchanged.

Pre-existing, and worth noting HOW it surfaced: an automated guard from S594
exists precisely to fail when a new kind of money charge is added without
declaring how it avoids double-charging. `carried_balance` was added in an
earlier session and never declared; regenerating the schema this session made the
guard fire. It did its job.

## 6. WHOSE MONEY EACH CHARGE IS — RESOLVED AND BUILT

Nic, DIRECTIVE: *"Late fees that come from the lease and are on the invoice need
to go to the landlord according to the lease. If you're talking about late fees
that would be in the one-off charges, those also need to go to the landlord. I
don't know why that would go to GAM. The only fees we collect are retries on ACH,
pass-through on card processing, and the subscription for various tenant opt-in
products."*

**The defect.** Only rent and utilities were ever split out to the landlord.
**Every late fee off a signed lease, and every one-off charge a landlord billed
by hand, settled with no landlord share at all** — the tenant paid it and the
money stopped on GAM's books. Silent both ways: the tenant's balance was right,
and the landlord had no line item to notice was missing.

**Why it needed a real fix and not a rule about charge types.** A landlord's
hand-billed lease fee and a GAM subscription were written into the ledger
*identically*. Nothing in the data could tell them apart after the fact. So every
charge now records **whose money it is at the moment it is created**, and the
payout engine reads that. Default is the landlord's — the safe direction, since
GAM's list is short and closed.

**GAM keeps only:** ACH return/retry, card decline pass-through, the
manual-payment recording fee, and tenant opt-in products (FlexPay, FlexDeposit
custody, FlexCredit, OTP float). Everything else is the landlord's.

**Two decisions Nic made here:**
- The **$10 manual-payment fee stays GAM's**. His three weren't exhaustive — it
  covers manual reconciliation and both Terms documents already disclose it that
  way, so nothing changed.
- A **property manager's cut DOES come off a late fee**, same as rent. One rule,
  consistently applied. Oak Park is self-managed so it changes nothing there.

**Also fixed in passing:** the landlord's own P&L was counting GAM's fees as
their income — every ACH-return and manual-payment fee the tenant paid inflated
the landlord's income statement. Now excluded.

### Smaller

- The autopay runner sends the tenant an email each time it runs and each time it
  fails. Wording is in `jobs/autopayRunner.ts` if you want to change it.
- Two tenants on one lease share a single autopay arrangement — whoever set it up
  owns it, and the other gets a clear message rather than a silent overwrite.
- Carried over from S608, still open: Oak Park master 22658 has no units assigned,
  no meter has an opening read, the apartment does not exist as a unit yet, and no
  trash meter exists.

---

## 7. TWO REAL BUGS THE TEST SWEEP TURNED UP

Both were hiding behind failures that looked like stale tests.

**1. Admins couldn't send onboarding reminders.** The permission check assumed
every reminder targets a tenant — but two of them target a *landlord*, so a
regular admin was refused for a landlord squarely in their own book, every time,
with no way to succeed. Worse, it also demanded an *active lease*: this feature
exists to nudge people who are still onboarding, which is precisely when there
isn't one yet. So it refused the exact case it was built for. Now scoped by the
target's actual landlord, whatever kind of target it is, with no lease required.

**2. A replaced unit silently lost its water fixture count.** When a unit is
retired and re-created under a new number, an automated guard requires every
field to be explicitly declared as copied or reset. The fixture count added by
the utility work was never declared. Left uncopied it would reset to nothing —
and a unit on a fixture-count water split would then contribute zero, under-
billing that unit and over-billing every neighbour on the same meter. It copies:
it's a fact about the physical space, and it's the same space.

A third, smaller one: a test helper offered to create RUBS master meters but the
option could never work — it always violated a database rule. Fixed, so the
option is real.
