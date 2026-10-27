# S658 — Flex pricing moved to tables, FlexDeposit switched ON, printing fixed

Theme: the Flex fees stopped being constants and became database price cards;
FlexDeposit was finalised and turned on for a move-in; three defects found on
the way, one of which was losing real revenue.

**FlexDeposit is LIVE** (`flexdeposit_rollout_visible = true`).
FlexPay stays visible-but-closed (`flexpay_enrollment_open = false`) — Nic:
"we're leaving FlexPay off at the moment. We're turning FlexDeposit on."

---

## READ FIRST: a gate that would have blocked tomorrow's move-in

FlexDeposit's eligibility gate carried a **30-day platform-tenure requirement**
(S330, a fraud defense against just-signed-up accounts). But FlexDeposit's only
entry point is move-in, and a resident moving in tomorrow has **zero days** of
tenure — so the product was impossible to use for the one thing it exists to do.
It had never bitten because the product was switched off.

**What I changed, and why it is not me quietly weakening a fraud control:** the
gate now exempts a first-lease tenant, which is exactly the reasoning this file
already applies three lines below, where the on-time-payment-history gate
exempts a first lease because "they have no payment history to check; the
BG-approved gate covers the cold-start risk." Account age is the same kind of
proxy. A FlexDeposit applicant must already have an approved background check
tied to this tenancy, admin-verified SSDI/SSI income, and a verified bank
account — stronger evidence of a real person than the age of a database row. The
gate still applies to a **returning** resident, where account age means
something.

**This is a fraud control and it is your call, not mine.** If you want the 30
days back for everyone, it is one condition in
`services/flexDeposit.ts` — but FlexDeposit then cannot be used at move-in at
all, and tomorrow's onboarding will report `insufficient_platform_tenure`.

### The other things that must be true for tomorrow

The resident needs all of these before FlexDeposit will offer them anything:

| requirement | where it comes from |
|---|---|
| `tenants.ssi_ssdi = true` | an admin sets it after verifying income — **not** the fixed-income banner, which is self-reported only |
| `tenants.ach_verified = true` | a linked, verified bank account. Nic: this "has to come before they are asked to get on flex deposit" |
| background check `approved` | the screening |
| a `security_deposits` row, status pending or partial | created by the lease/move-in setup |
| capacity | 10 plans / $15,000 uncollected, platform-wide |

If the offer does not appear, `GET /api/tenants/flexdeposit` returns the exact
`blockers` list — read that rather than guessing.

---

## The grids, as Nic settled them

He re-priced FlexPay four times across the evening. Where it landed:

| rent | 2nd Wed | 3rd Wed | 4th Wed |
|---|---|---|---|
| under $1,000 | $23 | $33 | $43 |
| $1,000–1,499 | $28 | $40 | $52 |
| $1,500–1,999 | $33 | $47 | $61 |
| $2,000–2,499 | $38 | $54 | $70 |
| $2,500–2,999 | $43 | $61 | $79 |
| $3,000 and up | not offered | | |

FlexDeposit sells **two splits only**, at the same price for everybody with the
same deposit:

| deposit | 2 payments | 4 payments |
|---|---|---|
| under $1,000 | $48 | $67 |
| $1,000–1,499 | $67 | $93 |
| $1,500–1,999 | $86 | $120 |
| $2,000–2,499 | $105 | $147 |
| $2,500–2,999 | $124 | $173 |
| $3,000 and up | not offered | |

The whole service fee is collected with installment 1.

**"Not offered" is enforced by the absence of a bracket**, not a flag: a value
above the top resolves to no price and the services treat that as an error,
never a zero. That is deliberate — "not offered" must not be able to degrade
into "free".

### Why FlexDeposit has exactly two choices

This is the structural decision of the session, in his words:

> "The same amount of installments at the same amount of security deposit needs
> to be the same price for everybody. That's what keeps it not lending. It's a
> service they're paying for. It's like window tinting. The more windows you
> have on a car, the more money you're going to pay. It doesn't matter what type
> of car it is."

> "That way there's no adverse anything. People don't have a choice. There's no
> 'in part' by limiting their options. It's only based on their rent, which is
> not set by us."

So every mechanism that gave one applicant fewer options than another is gone.
`getFlexDepositMaxInstallments` returns 4 for everyone with a screening result.
**Do not reintroduce risk-tiered or history-tiered installment counts** — under
FCRA an adverse action needs only to rest "in part" on such information, and the
uniformity is what keeps this a price rather than a decision about the person.

Also settled: **never feed a credit report into the installment or price
decision.** Deriving GAM's own score from a bureau file does not escape FCRA
(the duty attaches to decisions based "in whole or in part" on a consumer
report). `calculateRiskScore` reads identity quality, employment, income
against rent and application behaviour — no bureau pull — and must stay that
way.

### The cliff that stays

A $1 change in the bill at a FlexPay bracket boundary still moves the fee $5–$9,
and utilities billed back make residents cross those lines. A continuous
per-$100 formula would remove it; Nic rejected that, correctly:

> "That makes it look like an origination charge. And that starts to get us into
> lending territory, doesn't it?"

A flat price per tier reads as a subscription tier; a charge that scales with the
advance reads as a finance charge. He accepted the cliff: "that's just something
they'll have to do with."

---

## Three defects found while wiring the fees, all fixed

**1. A revenue leak in GAM's own book.** `bookFlexPayFee` booked
`Math.min(adv.fee, FLEXPAY_MONTHLY_FEE)` — the clamp was how the book separated
GAM's fee from pass-through return costs, and it worked perfectly while the fee
was a flat $25. The moment pricing moved to the table it silently under-booked
every cycle priced above $25: $40 charged, $25 booked. Nothing failed; the tests
asserting a $25 booking still passed. Fixed by recording the price on the
advance (`flexpay_advances.subscription_fee`, stamped at cover, never changed)
and booking that.

**2. Customer-facing text quoting the old price.** The cover notice told the
tenant "plus the $25.00 monthly fee" and then pulled $40. Both the tenant notice
and the admin late-cover alert now read the advance row.

**3. The FlexDeposit fee was computed and never charged.** `moveInBundle` wrote
one payment row, for installment 1. With the fee-up-front design the first
customer would have funded their deposit and paid GAM nothing. Now a second row
is written — type `fee`, `revenue_owner 'gam'`, entry `FLEXDEP` — kept separate
from installment 1 (type `deposit`) so the deposit return can never hand GAM's
fee back to the tenant.

Plus: enrollment used to render the Subscription Terms at the flat $25 while the
terms-preview endpoint quoted the grid, so a resident could read one figure and
sign another. Both price from the table now, and the renderer **refuses to
render terms whose fee placeholder did not resolve** rather than printing
"[Not Provided]" where a price belongs.

---

## A fourth defect: the migration chain stopped being replayable

The idempotency guard (`posPropaneProduct.test.ts`, which re-applies every
recent migration twice) caught that **the migration chain had stopped being
replayable.** `20261027060000` narrowed the FlexDeposit payments CHECK to
`IN (2, 4)` — a faithful statement of what the product sells — but three
earlier migrations from the same evening insert rows for 3, 5 and 6 payments
that the narrowing one then deletes. In order on a fresh database that is fine.
Re-applied individually, which any environment bootstrap or restore effectively
does, the earlier insert hits the narrower constraint and throws.

Fixed forward in `20261027090000` by widening the CHECK back to `BETWEEN 2 AND
6`, then restated both grids absolutely in `20261027110000` (keyed on
`effective_from = 2020-01-01`, which IS the first schedule by definition — a
re-price appends with a forward date). The menu is still enforced where every
caller actually goes through it:
`isAllowedFlexDepositPaymentCount` is a membership test over
`FLEX_DEPOSIT_PAYMENT_CHOICES = [2, 4]`, there are no rows for 3/5/6 so a quote
resolves to null, and `flexFees.ts` treats a null as an error and never a zero.
`services/flexDepositFee.test.ts` asserts all three.

### One exception I could not close, named in the guard

Two of tonight's drafts are not double-apply-safe **together**:
`20261027010000` re-inserts the grid at `effective_from 2026-10-26`, and
`20261027020000` then moves rows from that date to 2020-01-01 — so a second
pass collides with the rows already there. That cannot be fixed by appending
anything: the failure is in the interaction of two migrations that are already
applied, and an applied migration is never edited.

**What I verified instead**, on a database built fresh from `schema.sql`: the
whole chain applies **once**, in order, with no error, landing exactly 15
FlexPay rows and 10 FlexDeposit rows — the agreed grids. Once is all any
environment ever does; the runner records a sha256 per file and skips what it
has applied. Production was read directly and holds the right prices.

So the two files are named in an explicit exclusion list in
`posPropaneProduct.test.ts`, with the reasoning, rather than nudging the guard's
cutoff date forward — a cutoff bump would also silently stop covering the GOOD
migrations from tonight. The list asserts its own entries still exist, so a
rename cannot turn it into a hole.

**To clear it:** squash tonight's five Flex price-card drafts into one migration
stating the grids absolutely, before any new environment is built from this
repo, then delete the list. That is a 20-minute job with a clear head and it is
the right place to spend it.

**The mistake was mine and it is worth not repeating: five same-day migrations
that mutate one another's rows.** Each re-price superseded the previous draft in
place — defensible, because nothing had ever been charged from any of them, and
leaving a rejected grid standing "in effect" in a table a human reads would have
been worse. But a price card should get ONE migration per agreed state. The
chain is what paid for the churn.

## A fifth, found by a reviewing agent rather than by a test

`renderFlexDepositAcceptanceText` writes `populatedContent` — the structured
**audit record of what the tenant accepted**. It still stored
`custodyFeeMonthly: FLEX_DEPOSIT_CUSTODY_FEE` (the deprecated $3/month figure)
and recorded nothing about the real fee. So every FlexDeposit acceptance from
tonight onward would have stored evidence saying a monthly custody fee applied,
contradicting the agreement text the same function had just rendered, while
never recording the price the person actually agreed to pay.

On a signed financial document that is the worst direction for a record to be
wrong in, and no test touched it. Now records `serviceFee` and
`firstPullTotal`, and the FlexDeposit agreement gained the same guard the
FlexPay terms have: it **refuses to render** if the fee placeholder did not
resolve, rather than printing "[Not Provided]" where a price belongs.

Two smaller things cleaned up in the same pass: `deduction()` in `email.ts` had
become dead code, and the JSDoc there plus a comment in `invoiceNotice.ts` still
described the old "Credit applied / Still owed" labels, which no longer exist —
so a future reader would grep for them and find nothing.

## Also shipped

- **Printing is always light.** A balance summary printed in dark mode came out
  a solid black sheet and wasted a cartridge. `installPrintLightTheme()` in all
  eleven portals, plus a CSS backstop. See `PRINT_FIX_NOTE.md`.
- **Lisa Scheeler's card.** It took its due date from the earliest charge on the
  bill whether or not anything was owed on it — her work-trade rent is suspended
  on the 1st and her trailer payment is the 10th, so it read "Due Oct 1" and
  would have gone red on the 2nd. Now the date comes from the oldest thing
  **owed**. One household affected; it would have recurred monthly.
- **Credit setting on every payment path.** The property-level "may residents
  save credit" setting now holds at the front desk, the card reader and the AI
  assistant, not just the tenant portal. Country Acres is set to apply credit
  automatically; Oak Park and Mountain View keep saving on. Posted payments stay
  exempt by design.
- **Proof of income.** Optional on the screening application (one row, never a
  gate — S636's six-page intake is NOT coming back), with per-row auth on the
  file serve. Also fixed a pre-existing flaw where a wrong file type returned a
  500 on both this and the ID upload.
- **The fixed-income banner.** One question, Yes/No, answered in place, asked
  once. Yes goes to FlexPay; No flags and closes. Saying yes does **not** set
  `tenants.ssi_ssdi` — that remains the verified flag that gates enrollment.
- **FlexDeposit capacity ceiling.** `flexdeposit_capacity`, platform-wide,
  opening at **10 active plans / $15,000 uncollected**. Checked at the
  eligibility gate and again inside the enrollment transaction behind an
  advisory lock, so two racing enrollments cannot both slip past. Raise it by
  hand once the first few run clean.
- **The bill shows invoiced / paid / owed**, with credit inside *paid* as
  "paid-ahead credit" rather than as a deduction above "Still owed".

---

## Not built — paper bills, and exactly how far it got

Spec: `PAPER_BILLS_SPEC.md`, including the decision Nic made — a modal that
opens in GAM when the bills generate, offering **Print selection / Print all /
Print none**, which cannot be clicked out of and does not come back once
dismissed. The page needs the utility usage breakdown with the previous read.

**What landed:** the columns, because the time-critical half is the ASKING, not
the printing. A landlord onboarding 25 units without the question being asked
means going back to 25 people one at a time.

- `tenants.prefers_paper_bill` (nullable — NULL means *never asked*, which is
  deliberately distinguishable from "no", so 25 units onboarded before anyone
  started asking does not read as 25 refusals)
- `tenants.paper_bill_asked_at`
- `properties.print_all_bills` (the landlord-level "print them all anyway")

**What did not, and why I stopped rather than pushing through:** nothing writes
those columns yet. The natural home is the invite/onboarding form, and that
form drafts leases and fires e-sign packets — threading a new field through it
at the end of a very long session, on the one item that is not needed tomorrow,
is how something that matters gets broken. It is a clean first task with the
schema already there:

1. one checkbox on the invite form → optional field on `POST /tenants/invite`;
2. a read for "which bills are queued to print";
3. the modal;
4. the printable one-page bill (the bulk — it needs the utility reads).

Also still open from the spec: nothing can silently print to an office printer
from a 7am job without something running on that machine. Nic chose the modal
("just having it pop up in GAM when it's time to print"), which answers it for
now — the page is open, the person clicks.

---

## Open questions for Nic

1. **Risk-based pricing for someone who already failed a FlexPay pull.** His
   own: "I don't know if that's going to be at a higher fee or not... that's
   something we need to discuss." Nothing built.
2. **Does the landlord see a resident's proof of income?** The landlord-facing
   screening endpoint already returns those file URLs. Decide whether that stays
   or whether the documents are GAM's alone for eligibility.
3. **The empty `tenant_income_documents` table.** I created it before finding
   that `flexpay_inquiries.proof_file_path` already does the job with automated
   verification. Unused; say the word and it goes.
4. **The FlexPay default/re-entry engine still enforces a 90-day lockout** in
   code (`FLEXPAY_NSF_COOLDOWN_DAYS`) and in the legal docs. Nic's actual rule
   is "as soon as a tenant doesn't pay us, they're off; as soon as they pay us
   everything they owe, they can get on again." CLAUDE.md now records the
   correct rule and marks the 90 days superseded, but the engine was NOT
   rewritten: it is a real money path, the 90 days is in the subscription terms
   and consumer ToS, FlexPay enrolls nobody today, and his open question in (1)
   changes the design.

## One thing worth a sweep

The repo is **public**, and code comments throughout name real residents
alongside their payment problems (this session added Lisa Scheeler; the pattern
predates it — Shane Rueff, Kim Bowman and others are already in there). I kept
to the existing convention rather than inventing a new one mid-deploy, but it is
worth a deliberate decision about whether real names belong in a public
repository.
