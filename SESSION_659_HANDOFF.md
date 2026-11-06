# S659 — FlexDeposit's real exposure, FlexPay's ladder, left-owing end to end, and the names come out of a public repo

Theme: Nic answered a long list of open questions in one go and left it building
overnight. Nothing is deployed — he was explicit that the deploy waits until
everything on the list is done, and three items are deliberately AFTER it.

---

## The corrections he made, which matter more than the code

**The 762-person importer is CAMPGROUND MASTER, not Square.** He has already
imported the Campground Master schedule and customer base. Nothing from Square
exists yet; he will do the Square customer database and the archived invoices
later. Every Campground Master person will also be in Square, not the reverse.
Do not describe that import as Square data.

**FlexPay's 90-day lockout IS his rule**, reversing what CLAUDE.md and the S658
handoff both recorded ("was never his rule"). Asked directly:

> "I don't know what my actual rule is. That's what I thought it was. Like 90
> days and getting current. They can't just get back in if they haven't paid
> what they owe. 90 days is a cool-off period before they're re-invited for the
> first time. After that, the time might be longer. 6 months the second time
> and a year the third time."

**Left-owing has no grace period.** "if they have an outstanding bill and they
are trying to onboard with another landlord on GAM, like, that landlord needs
to see that they already owe. that's a real-time situation."

**FlexDeposit's exposure is not a running total**, which took three passes to
get right. It is concentration at a departure date, and only for residents
whose deposit GAM holds: "The data on other people moving out doesn't matter if
we don't have the deposit." Every figure computed against the 83 existing
leases was irrelevant — none of them has a GAM-held deposit, and FlexDeposit is
only ever offered at move-in.

---

## FlexDeposit

**The landlord is made whole, full stop.** Not GAM's option:

> "Any deposits we hold are absolutely going to the landlord. That is our risk
> to take, and that is why we are making the money on the flex deposit."

The arithmetic, after he corrected a misreading of it:

```
GAM pays  =  min(landlord's deductions, face deposit) − collected   (floored at 0)
```

A $1,000 deposit funded $500 where the landlord keeps $500 costs GAM **nothing** —
the "refund" of the other $500 was never the resident's money. GAM pays only
what the deductions reach past what is actually in custody, and never past the
face deposit: damage beyond the whole deposit stays the resident's bill exactly
as it would for anyone. `moveOutMath.gamCovers` is the one definition, so the
landlord's preview and finalize cannot disagree.

**Month-to-month splits a deposit 2 ways; a fixed term may split it 4.** His
reasoning: "we can't control what lease types a landlord offers, and we don't
want the landlord to block people from using our product." So the PRODUCT is
never gated on lease type — only the number of splits. Enforced in three places
(the offer, the agreement preview, the enrolment write), because a stale page
or a direct POST walks past a read.

**No schedule may finish after the tenancy does.** Nothing looked at the lease's
end date before this; a four-month plan could be written against a two-month
lease, making the shortfall certain rather than possible.

**The cash board** (`services/flexDepositExposure.ts`, admin → Reserve & Float)
is his flowchart literally: move-outs this month → do we hold their deposit →
owed vs funded → the difference is the cash. It short-circuits at every empty
step, so with no plans every figure is a true $0. Two traps it handles: a
rent-to-own end date is a purchase installment, not a departure (nine of the ten
end-dated active leases), and a tenant-owned dwelling does not end on its end
date at all.

**The reserve is real now.** FlexDeposit's service fee never reached
`platform_revenue_ledger` — FlexPay's always did — so every admin revenue figure
would have under-read GAM's income by every fee it ever collected. Four new
revenue types; the reserve is fees banked less shortfalls paid.

**A new bank or card restarts a stuck schedule** (`rearmMissedFlexDepositInstallments`).
It charges nothing: it re-arms the row for the ordinary installment cron, so
there is one charge path, not two.

---

## FlexPay

**The cool-off ladder, counted in days ON GAM.** 90 days, then six months, then
a year — and the clock only runs while they hold a lease here:

> "If they're 3 months into their year-long cooldown and they switch landlords,
> that cooldown only counts while they're on GAM. So if they leave GAM for 2
> years, they need to be back on GAM for the remaining 9 months."

No end date is stored, because a stored date keeps ticking while somebody is
gone. `flexPayCooldown` computes it from their actual leases, merging
overlapping ones so a resident holding two spaces does not serve it twice as
fast. **This removed the S578 terminal ban** — a permanent second-default ban
and a six-month second cool-off cannot both be true.

**Re-entry pricing:** the same price the first time ("I get that things happen.
Maybe somebody had an issue with their bank"), then **$5 more on every price
point** from the second. `flexPayCycleFeeForTenant` is the one function that
knows both the grid and the resident, so the quote and the charge cannot drift.

**The savings comparison** (`services/flexpaySavings.ts`) is built from what
actually happened to that resident — late fees that stood plus ones that were
waived, added back, against what FlexPay would have cost. It does not recompute
late fees from policy: reproducing `jobs/lateFees.ts` exactly (grace, accrual
period, accrual-from, the cap, first-charged anchoring) and getting it slightly
wrong would show somebody a fee their landlord's engine would never have
charged. The loss case is shown plainly and the enrol path stays open.

**The two doors to the survey:** two late months OR three clean ones. Lateness
counts on the facts of the bill even where the landlord charges no late fees at
all — "even if the landlord waived the late fee, we need to track, boom, this
person was late."

---

## Left owing — both doors, end to end

**First door:** real time (written the moment a move-out finalises owing, inside
finalize's own transaction), and now an approximate band rather than a figure:
"if it's like $600 or something, it'll say over $500." Rounded DOWN, so it never
overstates.

**Imported balances are a watch list and nothing is ever collected on them.** A
database trigger refuses an arrangement against one, so no later code path can
forget.

**Second door is not buying a debt.** His wording, which the code follows
exactly:

> "We don't phrase it as the landlord assuming that debt. We phrase it as the
> landlord will be collecting this debt on behalf of the previous landlord.
> It's not optional... There's no button they click to accept the sort of
> taking on the debt. It's they're clicking that they accept that a payment
> arrangement is going to be added to that tenant's portal."

So nothing in `services/leftOwingCollection.ts` offers a choice, and no function
provides a way to take the resident without collecting.

**The money:** installments ride the resident's rent as an ordinary carried
balance (`type='carried_balance'`), which means FlexPay never fronts them — GAM
should not advance one landlord's money to settle another's old debt. When the
line settles, the arrangement is credited and, once whole, the debt is settled
so it stops flagging — in the same transaction as the settle, because a paid
debt that still flags somebody is the worst failure this has.

**On departure** the first landlord is made whole, and the remainder plus
anything run up with the second landlord becomes the ONE debt a third landlord
sees. The chain is readable from either end (`carried_from_id` /
`carried_to_owing_id`).

**THE MONEY MOVES NOW** (built later the same night). The installment rides the
collecting landlord's invoice, so the allocation engine credited it to THEM like
any other carried balance — the dollar arrived with the wrong landlord and
stayed there. Two held items in the ordinary weekly batch move it: a negative
off the landlord who collected it, a positive to the landlord owed, on their own
property. At departure the remainder comes off the collecting landlord the same
way, which is his own rule from 10/20 — "if you click on this and they don't
pay, we're collecting that debt from you."

No new mechanism: held items already net positives and negatives in one payout
(S648), are already in the Tuesday batch, and are already ledger-captured.

**Both companies' books are right too**, which took one new account. A carried
balance posts to OPENING BALANCE EQUITY (A8, "a balance from before GAM") — on
a passthrough that would have said this landlord got richer by another
operator's debt. So `collected_for_another_operator` (2070, liability, CONTROL —
no hand journal line may touch it) holds it from the bill to the payout, and the
landlord owed books it against the receivable they were left with. Neither side
shows income or equity: that rent was earned and reported in its own months, by
the landlord who was left without it. `ledgerProjectors/leftOwingPassthrough.test.ts`
holds both sides.

**Decisions made without him, each reversible:** the landlord owed gets the
WHOLE amount collected (GAM takes no cut and eats none of it); a collecting
landlord who elected to cover processing fees covers this one too (their own
election, and GAM never absorbs a fee); and a move-out can still never fail
because of this — if the money move throws, the move-out goes through and a
CRITICAL admin notice says the landlord was not paid. That failure used to be a
silent log line.

---

## The names are out of a public repo

85 real people across **220 code files, 24 handoff documents and 8 filenames**,
plus the lowercase and email forms a capitalised sweep cannot see
(`razoandres60@t.dev`, `kim.harland`, `clay_simpson@example.com`). Every person
has a stable invented pseudonym, applied uniformly so test inputs and their
assertions moved together.

**Say this to Nic again if it comes up: the sweep does not remove the names from
a public repo.** Git history keeps every old commit readable. The only thing
that actually closes it is making the repo private, which LAUNCH.md already has
Ben doing before the GCP migration.

The Rhoades family is deliberately untouched — his own name in his own repo, and
`/Users/nicholasrhoades` is a real filesystem path.

Three things the sweep taught, worth keeping:
* A **uniform** mapping is what makes it safe — both sides of an assertion move.
* Pseudonyms need **globally unique** first names AND surnames, or two test
  subjects silently merge (the first attempt collapsed two people into one
  identifier and broke a declaration).
* `\b` is useless against `textContent` assertions, which glue names to whatever
  is beside them: `'RV 10Gerald Braddock'`, `'Ann FullerMH 07owes'`, `'pay
  linkAndres'`. The rule that works is a camelCase boundary.

---

## Also shipped

* **One search bar** in the landlord topbar, on every page, ⌘K from anywhere.
  Residents by any part of a name, spaces the way somebody says them ("mobile
  home 5" finds it at every property that has one), properties by name. Numbers
  match as whole numbers — a substring match returned MH 15 and MH 25 for "5",
  which is the opposite of what he asked for — and leading zeros are ignored
  because the spaces are numbered "MH 05" and nobody types the zero.
  **Note for the next new route on `landlordsRouter`: put literal paths ABOVE
  `/:id`.** `/search` below it was matched as an id and returned 403, which
  looks exactly like a permission bug and is not one.
* **A work-trade paper raised from a resident's page** now belongs to its
  agreement. The two doors inside the work-trade flow already linked it; the
  door a landlord actually reaches for did not.
* **The UTC-today bug is gone from the source** — 15 sites across 10 files were
  computing tomorrow's date after 5pm Phoenix, including price lookups that
  could quote a schedule not yet in effect.
* `tenant_income_documents` dropped (0 rows, nothing read it).
* The empty-warning-box blockers now say something, and the FlexPay reserve card
  says plainly that nothing funds it.

---

## Still open, in his own order

**Before the deploy:**
1. Left-owing disbursement netting (above).
2. ~~Documents tab~~ — **already built (S641); the backlog note was stale.**
   `documents.is_reference`, `document_properties`, an Upload Document button
   behind `documents.upload`, and a list that already resolves "the named
   property, OR any property in document_properties, OR nothing named = the
   whole company". I read the LAUNCH.md note instead of the code and built a
   duplicate `reference_documents` pair before catching it; dropped the same
   night (migration 20261028080000) and LAUNCH.md § 2c corrected. The lesson is
   CLAUDE.md's own recon-first rule: the handoff describes intent, the code
   describes reality, and when they disagree the code wins.
3. ~~FlexPay's "Learn more" tenant screen~~ — **BUILT.** `/flexpay` in the
   tenant portal, which is where the fixed-income banner's "Yes" has always
   navigated — the route did not exist, so that tap went nowhere. It asks ONE
   thing (the day their money arrives, never a preference) and then shows their
   own months: what their lease allowed in late fees against what FlexPay would
   have cost. No price grid, nobody else's late fee. Verified against demo data
   as a LOSS case (-$220 over 7 months) shown plainly with the way in still
   open, which is what he asked for.

   **The bug worth remembering:** the page was written reading the service's
   own `snake_case` field names. The API camelizes every response, so every
   field would have read `undefined` — a blank screen, no error, and a green
   suite, because the service tests never go through HTTP.
   `routes/flexpayLearnMoreRoute.test.ts` now asserts the keys the page reads.
4. PM portal demo login / walkthrough.
5. ~~"What do PM companies use that we don't have"~~ — **WRITTEN**,
   `PM_COMPETITIVE_AUDIT.md`. Three real gaps and they are all compliance
   paperwork: renters insurance (nothing at all), vendor certificates of
   insurance (two columns nothing reads or writes, zero rows), and a vendor's
   own login. Everything else on the standard checklist we have or have
   deliberately done differently, and on money movement, utilities, RV/stays
   and the change journal we are plainly ahead.
6. Booking-site customization — **NOT BUILT, deliberately.**
   `BOOKING_SITE_CUSTOMIZATION_SCOPE.md` says why: "Wix-style" is a page
   builder and that is weeks, and a tenth of it tonight is the worst version.
   The question for him is one line — did he mean "make it look like mine"
   (branding: days, and better AFTER the design pass) or a real builder (its
   own project)?

**After the deploy, explicitly:** the government forms library inventory, the
"expensive" look-and-feel pass and the logo, native apps, and moving the model
server off the payments host.

**Open question he has not answered:** the FlexPay bracket cusp
(`FLEXPAY_SAVINGS_SPEC.md` — rent-based bracket fixed for the term, recommended,
never agreed). Pricing still follows the bill, so a resident whose utilities
push them over a boundary re-prices month to month, which is the thing he said
he did not want.

**Housekeeping that cannot be done as written:** the note in
`posPropaneProduct.test.ts` says to squash the five 10/26 price-card migrations.
They are applied to production and the runner is fix-forward, so there is
nothing to squash — and the property it protects is already handled by
`20261027100000_flex_grids_stated_absolutely.sql`. Leave the named exception.

**MEMORY.md is 217 lines against a 200 limit** and needs consolidating.


---

## Two things found on the way, neither mine, both worth his time

**The demo environment has been serving a two-week-old build.** Port 4100 is
held by a compiled `dist/index` started **14 October**. Every demo given to a
prospect since then showed 13 days of stale behaviour, including the whole
fixed-income banner, which 404s there. Nothing was restarted — it is in use and
not mine to bounce. `gam-api-preview` (4200) runs current code from source and
is what I verified against.

**The tenant portal has no phone layout.** `.sidebar` is `position: fixed;
width: 220px` with no media query collapsing it and no hamburger anywhere, so at
375px the nav keeps its full width and squeezes every page into about 145px.
Pre-existing and portal-wide — not caused by the new screen, which itself
reports no horizontal overflow at that width. It belongs to the deferred
look-and-feel pass and the native apps, but for the audience most likely to be
on a phone it is worth knowing it is not a small polish item.

A third, smaller: `property_unit_type_late_fees` is the ONLY source of a
late-fee policy (S535, no property-wide default on purpose). A resident whose
landlord has never decided for their unit type sees no late-fee sentence on the
new screen, which is the honest answer — a figure there would be one nobody
agreed to.

---

## The gate

```
API         856 files   16,153 tests   ALL PASS
landlord     75 files    1,370 tests   ALL PASS
tenant       22 files      362 tests   ALL PASS
admin         3 files       86 tests   ALL PASS
pos           1 file        15 tests   ALL PASS
```

Five things went red on the way and every one was a guard this codebase keeps
on itself, catching new code. Worth listing, because the pattern is the point:

1. **A money table with no change journal.** `left_owing_collections` holds
   three money columns and the rule is that every money table gets the trigger
   in the migration that creates it. It did not. (`ledgerSourceFacts`)
2. **A money table not declared to the books.** Same table, named now as a
   passthrough: it posts from the payment, so the dollar is counted once.
   (`ledgerCoverage`)
3. **A test of mine searching a payload for bare digits** — the banned shape,
   because a uuid is hex and `'1430'` lands inside one about one row in two
   thousand. (`testsAreDeterministic`)
4. **A second hand-written copy of HELD_ITEM_SOURCES**, in `money.ts` as
   `HELD_PAYOUT_SOURCE_TYPES`. The CHECK and one list moved; the other did not.
   It is an alias of the real one now and cannot drift again.
   (`migrations.creditUses`)
5. **A new endpoint neither agent-reachable nor named as deliberately not.**
   `POST /me/flexpay-money-arrives` is now in DELIBERATE, for the same reason
   the fixed-income answer is: only the resident knows when their money lands,
   and this one has a price attached to being wrong. (`actionGap`)

And one that was not new code: `DuplicatePeoplePage.test.tsx` asserted an email
address the pseudonym sweep had renamed on the fixture but not on the
assertion, so the pair read as two different people. Fixed both sides.

## NOT DEPLOYED, and why

His sequencing was "everything else that I talked about... do all that before
the deploy", and booking-site customization is in that set and is deliberately
not built — it needs one line from him about what he meant. Holding the deploy
is therefore what he asked for, not a departure from it.

Everything else on the before-deploy list is done, tested and ready to ship the
moment he answers.

## Demo note

`alice@tenant.dev` on **gam_demo only** now has the password `demo1234` (set
with an assertion that refuses to run against any other database), and her
FlexPay survey answer is the 17th, which is what makes the Learn-more screen
show figures. Both are demo data.

To look at the screen: start `gam-api-preview` (4200) and `gam-tenant-preview`
(3102) from `.claude/launch.json` — the second is new tonight — and open
`http://localhost:3102/flexpay`.
