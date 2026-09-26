# Session 652 Handoff — 2026-09-20

Fresh-context start: read this. Everything below was built today and is on main.

## What this session was

Nic opened by asking me to check the S651 handoff **against the code rather than
trusting it**, because memories had been going stale. That was the right call
twice over: the handoff was substantially accurate, but the verification found
two live contradictions, and later in the session I asserted two things about
the product that were simply false. Both corrections are recorded below, because
the pattern matters more than the individual mistakes.

---

## Corrections Nic made, and what they changed

**"I don't want it flipped by a person."** On the portal lock I built, where GAM
reviewed candidates and acted. *"Choice creates the opportunity for
discrimination."* The manual endpoint is gone and the rule runs itself.

**"That seems like a broken workflow."** On the register's pay-link path for a
stay, and on my refusing it rather than making it consume inventory.

**"Where is your method coming from?"** On a bug description too vague to argue
with. "A stay went out on a pay link" hid which of three doors was at fault.

**"One price, and it is the unit's."** Counted by him as the eighth time he had
said it: *"There's no variation allowed in terms of charging one price in the
booking flow and one price if they come in and get it on the POS and one price
if they do whatever. It's all the same. It's based on the unit."*

S651 had recorded the opposite — that a register stay's price was its own thing,
separate from the rate card. The data settled it: Mountain View's units said
**$269 a week** while its register item said **$250**, and nobody could have told
you which one a guest owed. Oak Park's sites already carried $40 / $200 / $440 —
exactly the numbers Nic quoted from memory — so there was never anything to "add
at Oak Park's prices." The memory that said otherwise has been rewritten.

**"That is absolutely fucking false."** I stated in bold that tenants cannot have
a card on file. Wrong. Save-and-pay is one authorization and it is how GAM has
always worked (S603) — a tenant who has paid rent by card once already has a
saved card. The rule was only ever "don't spend a second authorization to store
one." I checked the code before replying the second time, which is what I should
have done the first time.

**"I don't think you're right on the customer picker."** Also correct. The
register's people search already unions the account's tenants with its POS
customers — his one-way valve, all tenants are customers, not all customers are
tenants. I claimed it searched POS customers only without looking.

**"It's not a form, it's a flow."** The reservation work is a sequence on the
Master Schedule, not a form to fill in: dates → Show available → what the
customer is told → the space → then names.

---

## Built this session

**One price, everywhere.** A stay is priced from the site's rate card, falling
back to the property — the same two places in the same order the booking site
already used, so the counter and the booking site cannot disagree. The catalog
price on a stay item is not consulted at all; the button says "price by site."
The counter's site list now carries what each site IS (pull-through, 50 amp) and
what the stay costs, because that is what gets read out loud. A site with no rate
is listed but not sellable — dropping it would read as occupied, which is a lie
about an empty site. A stay can no longer go out on a pay link, which would have
taken money and put nothing on the schedule.

Data: Mountain View's units got $589/month (what it has been charging) and its
stale $250 property weekly became $269. Oak Park got the three stay buttons it
never had.

**The reservation flow.** Nic's order, not the old one: dates → "Show available"
→ the list with facts and prices → pick the space → then name, phone, email →
deposit link emailed. The old screen demanded a stranger's contact details before
it would show a single site. Nothing is written until the last button; backing
out drops everything — "it's more like a browser than anything else."

**A hold with no clock on it.** Asked to pick a hold-expiry window, Nic gave a
better rule: *"there's no timer for deposit link but if it's not paid and someone
else pays it boots them as unconfirmed when there's no other spaces."* So an
unpaid hold never expires — nobody loses a reservation for reading their email on
Monday — but it does not outrank money. When somebody pays, the holder is moved
to an equivalent free site; only a genuinely full park costs them the
reservation. A moved guest gets an email with their new site number. A displaced
one does not: that is a phone call, and the landlord is told so with their number.

**The register charges a card on file.** For propane delivered off the park. The
saved card lives on GAM's platform customer and register sales are created on the
platform account too, so nothing exotic was needed — only a tender. It is its own
payment method rather than being written down as `card`, because at end of day
"which of these went through the reader" is a question somebody asks while
counting a till.

**Open tickets — written up at the pump, settled at the door.** The dispenser is
in the office and its counter has to be zeroed before the next tank, so the
gallons are known there and the money happens at somebody's door hours later. A
ticket holds **no money** — no total, no tax, no fee — because freezing a price at
write-up would be a second pricing authority. Settling is an ordinary sale that
claims the ticket inside its own transaction, so two drivers with the same ticket
open cannot both charge for one tank.

**GAM's own collections book** (`/api/admin/collections`). Distinct from
`/earnings`, which books a fee when it is EARNED and is silent on whether the
money arrived. This separates billed from collected and names the gap, including
the settled landlords — a report that only lists problems cannot say whether it
is two out of three or two out of two hundred. Writing it found a bug by hand:
the netting check queried `status = 'succeeded'`, which is not a status that
exists, so it matched nothing and would have called every landlord uncollectable.

**Reaching out, then the lock — which no human applies.** A landlord GAM cannot
collect from is told once, early, with the fix and the reassurance that their
tenants are unaffected. If it comes to it the portal is suspended, by a standing
rule running at 09:00: two uncollected billing cycles plus 48 hours, and only
when there is genuinely no way to collect — no rent moving to net against, no
bank linked to debit.

I first built this as a list a person at GAM reviewed and acted on. Nic threw it
out: *"I don't want it flipped by a person... choice creates the opportunity for
discrimination."* He threw out a dollar trigger with it — a flat $500 is four
years of patience for a duplex on the $10 minimum and a fortnight for a 300-unit
portfolio. Two cycles scales itself. It returns 402 with `ACCOUNT_LOCKED`, never
401, the bank-linking route stays reachable, access is restored automatically
the moment the balance settles, and tenants are never touched.

**Stays are inventory, at every door.** A cashier could tap a stay item into the
register cart and press "Email a pay link" — that route had no notion of a site
or a date to ask for, so it took money and the schedule never heard. My first
fix refused it; Nic pointed out that refusing is wrong, because *"when I send a
pay link, it should use up inventory according to what spot was booked and for
how long."* It now carries the site and takes it off the board when the link is
SENT, held and unpaid, displaceable by anybody who actually pays.

**The walk-in.** Somebody shows up wanting two nights. The reservation flow had
one exit — email a deposit link — which is absurd for a man at the counter. It
has two now, and both commit the inventory at the moment the site is chosen.
Sending it to the till writes a ticket carrying that booking; ringing it confirms
THAT booking rather than writing a second one for a site already committed.

**Every number on the admin money page comes from one book.** Nic reproduced the
discrepancy to the cent — $172.72 in the pies against $218.87 on the card. Three
books were being added: accruals plus a live run-rate for platform fees, a count
of background checks times a constant, and adjustments that existed only in the
ledger. Everything now reads `platform_revenue_ledger`. Recurring revenue is the
bill that actually went out ($130) rather than a re-derivation from current
occupancy ($120) — "active now" is not the set that was billable when the bill
was raised.

**What GAM bills for, counted in one place.** Nic spotted the admin page saying
$120/month recurring when September actually billed $130, and neither of my
explanations survived contact with the arithmetic. The estimate counted units
with `status = 'active'` and handed the result to a function whose parameter is
named `occupiedUnits` — dropping ten DELINQUENT spaces, one at Mountain View and
nine at Oak Park, each with somebody living in it who owes rent. My first fix
counted everything not vacant and promptly invented $10 for Springville, whose
single unit is marked `active` with **zero leases**: the landlord set that status
by hand three days ago, clicking vacant → available → active in three seconds,
and no tenant has ever existed there.

The lesson is the session's own theme. A unit's status is a claim somebody typed;
a lease is a thing that happened. The accrual has always counted leases, which is
why it was right both times. The count now lives in one function that the accrual
and the estimate both call, so the two cannot disagree again.

**Chasing it found a real hole.** An `owner_use` space has no lease by design —
that is the anti-cheat, so nobody parks a relative in a spot and calls it rented.
But the billable count is lease-driven, so "no lease" was quietly also making the
space free to run. Worse, the grace ends on occupancy measured the same way, so a
landlord whose only occupancy was owner-use would have sat in grace forever:
never activated, never billed, however many spaces were full. Both now count
owner-use. Nothing to back-bill — none exist yet.

**One packet, two signatures, on a brand-new tenancy.** Nic: *"I don't understand
why it's any different for a brand new tenancy or onboarding."* It isn't. Two
things stood in the way and only one was the lease: ticking an installment-sale
template produced a signable agreement with **no contract row behind it**, so
signing it billed nothing and said nothing — which is how Country Acres ended up
with eleven voided contracts. The terms now come in with the draft or the draft
is refused. And the lease adopts a contract that predates it the moment it is
created, scoped to this unit and the people actually on this lease.

The home-sale guards moved into the service so the packet runs the identical
ones: mobile homes only (S613), park-owned only, buyer must have standing.

**Country Acres had two sets of lots.** Nic, on the unit count: *"He had
previously added 11, but never onboarded the right way. And I'm thinking you just
added a bunch more and ignored his existing 11... I can see he has 47 units which
doesn't make sense."* He was right. The load script wrote 36 lots with raw SQL,
bypassing `canonicalUnitNumber`, so Blu's own eleven `MH NN` units sat beside 36
new `Lot N` ones and nothing joined them — the property's own water meters were
already named `MH 01`, so the park had been disagreeing with itself. The eleven
empty duplicates are deleted and the 35 renamed; Country Acres reads 36 units.

**The back-end name and the printed name are different jobs.** Nic: *"They can
call it lot one on the lease, but it needs to be mobile home one in the system so
that we are accurately treating like unit types the same consistency platform
wide... if it was technically an RV spot and they called it lot one, then it would
be compatible on the scheduler to move around with other short-term stay sites,
versus a mobile home. You cannot put an RV in there, which is why the distinction
on the back end matters. I don't give a shit what's on the actual lease."*

`units.display_label` carries the park's own word for the space; `unit_number`
stays canonical and is what every schedule, availability check, meter and packet
reads. One helper, `printedUnitNumber` in the shared package, decides what a
lease prints: display label first, then the canonical name, with the leading word
stripped because the form already prints "Lot #" beside the box (S632). Both
prefill paths call it — the S556 unit prefill, which was the one actually filling
the box and was reading `unit_number` raw, and the S629 identity block behind it.
Country Acres is backfilled: MH 00–MH 34 in the system, "Lot 0"–"Lot 34" on the
page. The label never decides what a space IS; an RV spot called "Lot 1" is still
short-stay inventory.

**The acknowledgements are their own document now.** Nic, on Blu's lease: *"is
that acknowledgement a legal requirement? And is that also in your disclosure
list?"* — then *"can you get those acknowledgements, a copy of those into the
system?"* It is, and it was, but only as four initial lines on page 4 of one
park's form, which cannot be sent to a tenant who signed on paper years ago and
cannot be reused by the next Illinois park. It is now a one-page form tagged
`statutory_acknowledgement` / IL / rental, with the four lines fielded: the IDPH
pamphlet, the lease exhibited before signing, the written 24-month offer on a
date preceding signature, and the park rules.
`apps/api/src/scripts/mattoon/load9_il_acknowledgements.ts` built it; template
`c5ad6ff1-d085-4053-91cd-aba3b0774fc9`. **Deliberately NOT added to Blu's
packet** — his lease already carries these lines, and asking one household to
initial them twice is worse than once.

**A shelf of forms GAM did not write.** Nic: *"the library should only be
government published documents that something we're not altering at all...
Anything that the landlord has to publish, they can do on their own. They can
upload their own form the same way they upload their own lease."* And on why the
statute text stays off the screen: *"a landlord may have properties in multiple
states. We don't want to clutter all that screen."*

The case was already in the data — Blu uploaded his own copies of the FEDERAL
lead-based paint disclosures, identical for every landlord in the country, and
every landlord after him would have uploaded them again.

Adoption makes an ordinary `lease_templates` row linked back to the library, so
packets, sending, signing and stamping work untouched; it is a template, only
locked. That link is what makes the annual refresh reach people. It cannot reach
backwards — `lease_documents` carries its own PDF and its own copied fields, so
somebody who signed version 1 signed version 1. There is a test for that.

The lock is both halves of what Nic asked for: *"they can't alter the document,
but when they send it out for signature, it needs to have e-signature flow on it
where the page can at least have the tenant's initials."* The library owns the
PDF **and** the field map; the landlord edits neither, but can take it off the
shelf and pick it in a packet. The refusal names the way out — upload your own.

The action-parity guard caught the new endpoint. Rather than name it deliberate, the
route resolves a SPOKEN name, because the existing lease-template actions all
take an id "from a lookup" and no lookup returning template ids exists — they are
unreachable by talking. This one is not, and it refuses to guess: no match and
two matches both read back what is on the shelf.

**Stocked, 2026-09-21.** Five forms, each the agency's own file byte for byte,
each with a title-case name that says what it is:

- Lead-Based Paint Disclosure — Rentals (EPA Form 9600-041)
- Lead-Based Paint Disclosure — Sales (EPA Form 9600-040)
- Protect Your Family From Lead in Your Home (January 2026)
- Living in a Manufactured Home Community (Illinois, 2018) — the statutory
  pamphlet; its introduction cites Section 14-1, which Blu's acknowledgement
  refers to
- Illinois Mobile Home Landlord and Tenant Rights Act (765 ILCS 745)

`apps/api/src/scripts/disclosures/stockLibrary.ts` loads them; `PREVIEW=<dir>`
draws every default box onto a copy for checking. **Check the render** — it
caught two boxes sitting over EPA's printed words on the first pass. The
remaining inventory is LAUNCH.md §2e.

**The lock, corrected.** The first version locked the boxes along with the text.
Nic: *"they can't edit the text of the document because it's a government
published form. They can add the necessary initial boxes... just including it
with the signature in the packet with no actual initial on the page itself is
going to be argued that it was never received."* Now only the PDF, page count,
name and description are fixed; every box is the landlord's.

**Two lead forms, never three.** Nic asked what the pamphlet is for. A pre-1978
home needs ONE disclosure form — Rentals or Sales, whichever the deal is — plus
the pamphlet, which line (d) of either form has the tenant initial as received.

**The screen:** GoldSign → Government Forms. Verified in the LIVE bundle
(`index-B8VX-UbS.js` contains the tab), not just the build log. Nobody has
looked at it logged in — that needs Nic.

**The first refresh case arrived before the mechanism did.** EPA reissued
"Protect Your Family From Lead in Your Home" in **January 2026** for the new
dust-lead action levels. Every copy downloaded before that is stale. Blu's
lead-paint FORMS are fine — that wording is fixed federal regulation — but the
PAMPHLET he hands over with them is the thing that changed, so the Sheptocks
should get the January 2026 one.

**Lot 1 cleared for a redraft.** Nic: *"remove everything from lot one... get
those forms in there for the package... he needs to edit whatever box is on his
template first."* Nothing was signed. The three live documents are voided (not
erased), zero signing requests remain open, and the pending sale is cancelled.
On Blu's shelf: EPA's Sales form, the January 2026 pamphlet, and IDPH's
community guide. Retired (one click restores any of them): his own two
lead-paint uploads — tagged as LEASES, so the lease picker offered them — and the
acknowledgements form I wrote on S652, which is GAM-authored and so falls
outside the rule Nic set today. `load10_clear_lot1_stock_blu.ts` did it.

**NOTHING HAS BEEN REDRAFTED OR SENT.** The order is Nic's: Blu fixes the box
on his lease template (the Lot # box that sits off to the right) → Nic confirms
→ draft Lot 1 as lease + installment contract + EPA Sales form + lead pamphlet +
IDPH pamphlet → Blu blesses it → then the other twelve.

**A void left the sale behind — fixed at the table.** Clearing Lot 1 found that
voiding an unsigned installment agreement left its sale at `pending_signature`
forever, and one live sale per unit meant Lot 1 could never have been redrafted.
Documents are voided from FOUR places (the button, the 48-hour timeout, the
renewal auto-void, the add-a-person redraft), each with its own partial copy of
the steps, so the fix is a trigger (`trg_cancel_unsigned_sale_on_void`), not a
fifth copy. The button's steps also moved into `lib/voidDocument` so scripts run
the same ones. Zero sales were stranded in production before this.

**Templates are sleeves now.** Nic: *"right now, all of my templates are just
sitting there in a pool instead of in a designated card slot... if I upload my
Arizona property and twelve documents are anticipated, that shows twelve
blanks... They're not required to use the blank spots. But that hint of hey,
there's more things to upload is there."* The sleeve is the slot; the card is the
document in it.

- **Catalog** — `document_sleeves`, 811 rows, from the statute corpus by
  `scripts/disclosures/buildSleeves.ts`: a lease per unit type per state (561),
  a mobile home sale contract per state (51), and 199 document sleeves across 43
  states wherever a state's act has the landlord hand or tell the tenant
  something, scoped to the spaces that act governs. `REPORT=IL,AZ` prints the
  statute sentence behind every one. Took four matching passes; every IL and AZ
  hit was read against the statute, TX/CA/FL spot-checked. Errs toward leaving
  one out.
- **Corpus mislabels found:** IL `rv_park` is a 45/45 copy of the mobile home
  act; IL `commercial` is eviction + residential. Routed around here; the fix is
  a separate task (chip raised) — along with `state_landlord_tenant_acts`, which
  the agents use to find the governing act and which holds ONE state.
- **The page** — one section per state the landlord holds property in, the
  sleeves for the unit types they run there, numbered so gaps read as gaps.
  Government forms sit in theirs already. Nothing says required. Upload into a
  sleeve and it takes the sleeve's type, unit type and state. Unfileable
  templates show under Other documents. All seven existing templates filed.
- **"Already in…"** — Blu's lease carries his park rules and owner disclosure as
  exhibits; a sleeve can be covered by a document he already has
  (`sleeve_coverings`) instead of reading as missing.
- **Library is relevant-only** again — Federal plus their states, for the spaces
  they run. The federal lead forms are scoped to housing.
- **Packages** keep a state; **Fill from my documents** adds every filled sleeve
  for that state and unit type (default lease if two; Sales or Rentals lead form,
  never both; nothing covered).

For Blu's Lot 1 packet the order is unchanged, but step 3 is now one click: a
package for Illinois / mobile home with "Includes a home sale" ticked fills with
exactly lease + installment contract + EPA Sales form + lead pamphlet + IDPH
guide — once he has marked his park rules and owner disclosure as "Already in"
his lease.

**Sleeves, second pass (Nic's corrections the same day).**
- **Auto-detection replaced "Already in…".** `services/sleeveDetection.ts` reads
  every landlord document on upload and on PDF replace. It goes by section
  headings, plus a few body signals: the owner name-and-address block, utility
  billing, "acknowledges receipt of", and — added late S652 — a hazard the
  document keeps discussing (bed bugs, mold, radon, asbestos: 3+ mentions). The
  last came from Nic: his Oak Park apartment lease has a bed-bug clause and
  EPA's flyer attached, both in Title Case, so no heading matched.
  - Every re-read replaces that document's automatic ticks, so a section dropped
    from next year's draft un-ticks itself. Ticks the landlord set by hand are
    never touched.
  - "It's in another document" is a checklist, shown on documents only (never on
    leases, sale contracts or notices).
  - `scripts/disclosures/redetectAll.ts` re-reads everything after a detector
    change.
- **Duplicates.** Blu is an owner-member of Oak Park, so his view spans two
  companies. The library now dedupes to one copy per viewer.
- **Cards are wide and short**, nothing is truncated, and every group starts
  collapsed.
- **Locked late-fee boxes** can be moved and resized; only the value is locked.
- **Free government versions.** A state's own version of a document fills the
  matching sleeve and also lists under Government forms. A state model lease
  would fill the lease sleeve.
- **Read only.** A government PDF that is locked against editing (IEMA's sales
  radon pamphlet) can be viewed and handed out but never stamped. `/upload`
  refuses encrypted PDFs.

**Government library — the rule is Nic's: "If the government provides a
document, we are adding it to the library. That's it."** Claude sources every
document; Nic does not download anything. `stockLibrary.ts` is the one source
for each document's file, title, boxes, source file URL, and (new) the agency
PAGE to check for the next edition (`source_page_url`). A newer edition names
the file it `replaces`; shelving it retires the old one and moves every
landlord copy over (`resyncAdoptions`). Signed documents keep the edition that
was signed. Every file lives in `apps/api/uploads/leases/library-*.pdf` on the
Mac Studio (nightly backup).
- **Federal (4):**
  - EPA 9600-041 (rentals) and 9600-040 (sales)
  - *Protect Your Family From Lead in Your Home* (January 2026)
  - *Renovate Right* (September 2011, still EPA's current edition). Its sleeve
    fills every housing state's lead slot; in a package it is for renovation
    work, not move-in.
- **Illinois (7):**
  - IDHR Safe Homes summary, **December 2025 (V.2025-12.3)**, which replaced the
    October edition. It has signature rows on all 4 pages; the rights take
    effect 1/1/2026.
  - IEMA radon: the tenant disclosure, the tenant guide, and the sales
    guidelines (read only)
  - AG landlord-tenant fact sheet
  - IDPH *Living in a Manufactured Home Community* (the pamphlet 765 ILCS 745/14-1
    has parks offer every tenant)
  - IDPH printing of the MH act
  - **Illinois lead:** 77 IAC 845.25(b) only asks for a brochure "consistent
    with" 40 CFR 745, so the federal pamphlet covers it. There is no separate
    Illinois brochure.
- **Arizona (5 active):**
  - Residential act (May 2023) and MH parks act (2024), both through
    web.archive.org
  - UA bed-bug bulletin (2012)
  - ADHS bed-bug toolkit (2019)
  - Phoenix guide (2014)
  - The Spanish act is retired (English only, Nic).
- **Arizona, closed 9/21:** housing.az.gov blocks scripts with a Cloudflare
  check, so Nic ticks the box in his own browser and saves the PDF, and Claude
  checks and shelves it. That brought in the **September 2026 MH parks act**
  (replaces 2024: new relocation-fund amounts under an unchanged cover date)
  and the **Director-approved summary** (updated 9/10/26), which A.R.S.
  33-1432(G)/(H) has parks give before the rental agreement and every
  November 1. The Residential act's current edition is still May 2023
  (checked on the agency page 9/21).

**Tenant portal — "Landlord-Tenant Act".** New sidebar page (`/laws`, API
`GET /tenants/me/laws`). One section per leased home: the state's act for that
kind of space, then the state's guides, each showing its publisher and edition.
It updates automatically when a new edition is shelved.

**Mountain View leases never mention Oak Park.** The RV and MH lease PDFs were
corrected in place:
- LLC: "Mountain View RV Park Ranch LLC"
- Manager: Nicholas Rhoades
- Rules titles: Mountain View

Both templates now point at the corrected PDFs with every box kept. The 37
completed leases keep their signed text. **4 in progress (3 MH, 1 RV) stay on the old
file** — Nic decided: do not void; they are signed as sent, the corrected text is
for every lease from here on.

**Voided documents that were never signed** are hidden from the documents list
(kept, never deleted).

**Mountain View payout ($4,154.89).** The money reached the Connect account
Saturday, after that week's payout run, and the manual payout schedule left it
sitting there. Nic paid it out by hand at 12:18 (arrives ~9/21–22). The balance
is $0, so the evening run cannot double-pay.
- `jobs/autoPayouts.ts` now has a **catch-up**: a transfer that lands more than
  an hour after its intent and after the landlord's last payout is paid out
  the next day. `disbursements.trigger_type='catch_up'`.
- Claude does not create payouts or move money itself; that stays with Nic.

**Work trade, built out (late S652).** One window for landlord and tenant
(`packages/shared-ui/WorkTradePanel.tsx`): duties, skills, covered charges,
this month's hours, the review day (last business day), each person's record
(turned in / approved / denied, by count and hours). Trusted or Monitored per
person; Logged → Approved / Denied. Jobs from the tenant portal: open work
(general, grounds, cleaning, pests) to every work trader at the property,
skilled work by skill; take, mark done, log hours in one step; a monitored
person's skilled job waits for a trusted work trader or the landlord to confirm.
Neighbours' contact details never reach a work trader. Jobs go back on the
board when an agreement ends or sleeps for the season. Field permissions
(`field_permissions`, first one `read_meters`): the meter walk moved to
`packages/shared-ui/MeterWalk.tsx` and a work trader with Read meters takes it
from their Work Trade tab, own property only, never the review. Indefinite
carry-forward (`carry_forward_indefinite`). Curtis Clabough: 25 hrs, no limit,
reads meters.

**Utility bills wait for the landlord — when the company chooses.** Blu asked to
see and correct bills before tenants do. It went platform-wide for an hour, then
Nic separated two things: WHO may enter readings is a per-person permission
(Team page; a work-trade agreement's Read meters), WHETHER the bills wait for
approval is the company's own toggle on Settings (`landlords.review_utility_bills`,
off by default; TruBlu / Country Acres on). A month's readings are priced by the
same engine (`services/utilityReview.ts`), left unissued, and shown on the
Meters page (Review bills & approve) with previous / this month / usage / bill
per site. A read can be fixed in place until approved; approving completes the
run and issues the bills. Invoices carrying those utilities wait, whole; an
unread or flagged meter bills nothing and holds only its own unit — approval
never waits on it. The landlord is notified when the last re-read lands.
Tenants never see an unissued bill; the landlord's bill list was empty for
every landlord (read profileId) and is fixed. Digits editable per meter; a
readings spreadsheet (CSV) per property.

**Country Acres, closed out.** 11 orphan duplicate water meters (no site, no
read) deleted; the 13 real meters (occupied lots) hold the 8/26 baseline; the
August run is closed with no bills. September usage → October invoices, all 13,
via `is_existing_tenancy` (onboarding leases bill from the baseline whatever
their start date). Lots 21, 22, 24 still flagged no-movement → re-read.

**The invite shows the packet (late S652, three corrections from Nic).**
Nothing is chosen at invite. Pick a unit → the unit's default package is
listed, pre-ticked, with the reason for anything left off; untick what does not
apply; the ticked list rides `pending_tenant_intents.package_template_ids` and
drafts exactly that through every drafting door (`services/packetDraft.ts`).
No package for that state × unit type → **Build the packet from my documents**
on the invite (`buildDefaultPackageForUnit`: default lease + filled slots +
government forms + unfiled documents that fit, saved as the default). No lease
template at all → sent to Templates. Park-owned home only → **Selling them
this home on installments?** with the terms (`home_sale_terms` on the intent;
the draft writes the sale and links the contract; refused if the package has no
installment contract). Future (Nic): counsel-reviewed GAM-approved documents
per state as free-version slot fillers.

**Blu's package save.** Documents and packages belong to the ACCOUNT
(`account_companies()`, `fileUnderCompany()`); no "choose which company"
question anywhere on documents. Errors show the server's sentence in both
portals.

---

## Verified against code, not taken on trust

These S651 claims held up: the 08:30 fee-debit sweep with no consent gate, ACH
at $6 flat from the shared schedule, the suppression check on the single send
path, the 04:35 mail sync and 03:50 geocode retry, the renter pool, register
stays, and Country Acres' 13 sent leases / 11 voided contracts. The 47-lot
count was real and was the bug — see "Country Acres had two sets of lots" below.

Two contradictions found and fixed: the scheduler still described the sweep as
"only landlords who explicitly authorized a debit" (it considers everyone who
owes), and a comment claimed GAM pulls from "the bank they authorized" — they
authorized a bank *feed*, which is exactly why both existing links fail the
`payment_method` check.

One S651 claim was self-contradictory and is now moot: the handoff said the home
sale both did and did not require a lease. It does not, and now the packet works
either way.

---

## Outstanding

### Needs Nic or Blu
1. **Money fields on Mattoon's installment contracts** — the sheet records what
   is LEFT ($11,000 over 55 months), never the original price or down payment.
2. **Lisa Scheeler's permissions** — Nic checks Tuesday, she is not in before then.
3. **Stripe rep: card reader.** Nic is ordering the **S710** (same price as the
   S700, adds offline mode; cellular optional and not needed — WiFi/Ethernet or a
   phone hotspot). Worth asking the rep, in these words: can an S710 run a custom
   app on device, and does offline store-and-forward apply to server-driven
   internet readers or only the mobile SDKs? Accessories: the dock earns its keep
   (check whether it is the Ethernet one), the $5 test card is a **platform-side**
   purchase for proving the flow once, the case only matters once the reader
   travels — which it now will, for propane.
4. **Lot 1 waits on Blu's template fix, then a redraft.** (See "Lot 1 cleared"
   above — the earlier packet is voided.) History: The 13 originally-sent leases were
   deleted, not voided: they were drafted before the co-tenant roles were fixed,
   so 70 of 125 template fields never landed, nobody had signed them and nothing
   referenced them. Nic: something *"that was never a real issue, of real
   substance or value to the system... needs to just kind of be pruned
   completely."* Lot 1 went back out as the real three-document packet (lot
   lease + installment contract + lead-based-paint SALE form) with John Sheptock
   as signer and Nancy as authorised occupant. The other twelve wait on Blu
   blessing this one. Invoicing backfills 30 days, so a signature any time
   through about **30 October** still bills October in full; after that, October
   has to be billed by hand.
5. **Country Acres onboarding window expired 9/11** — left alone deliberately.
6. **What the Office lot actually is.** It is loaded as `commercial` with no
   display label. Nic: *"the office building is I think it's a single wide
   trailer that's on its own lot that they may be trying to sell off so that
   might actually be considered a mobile home too"* — he is unsure and wants
   Blu's answer. It matters because the type, not the label, is what decides
   whether a space can ever be scheduled as short-stay inventory. One field
   change once Blu says.

### Still to do at Mattoon
7. **The 11 installment contracts**, after the leases are signed. The packet now
   works either way, so they can go out with a lease or on their own.
8. **Six adults are occupants, not signers.** If any should be liable co-tenants,
   Blu collects their addresses and they go on by addendum.

### Built but never exercised
8. **The ACH fee debit has still never run against a real bank.** Both links
   predate the `payment_method` permission. Mountain View owes $82 and Oak Park
   $48, both under the $100 threshold. The landlord now gets told when this
   happens, which is new — but nobody has crossed the threshold yet to prove it.
9. **The renter pool has no members.** `application_pool` is empty; the intake is
   wired to a landlord-less background check and nobody has taken one.
10. **Everything built today is unexercised by a real person** — the reservation
    flow, the card on file, the tickets, the packet.

**What GAM bills for, written down once.** The billable test is now evidence of
use, in one function both the bill and the admin estimate call: an active lease
(delinquent and hibernating included), an owner-use space, a utility-service
space, and short stays as nights ÷ 30. A unit's *status* is not an input and
must not become one — Nic reads `active` as "available", the landlord at
Springville set it by hand with no tenant, and it produced a phantom $10.

**A stay cancelled after arrival is a stay.** Nights bill in arrears and the
accrual runs on the 1st, so excluding anything flagged `cancelled` — with no
check on when — was a free month for the asking: let them stay, take the money,
cancel on the 30th. Now exempt only if cancelled before the check-in date, with
a database trigger stamping the moment so no call site can forget it. No-show is
out of billing entirely, per Nic: the site was held either way.

**Mattoon's leases were unsignable, and the cause was not Mattoon.** Blu read
the thirteen and reported that tenant names did not populate on pages 1, 5 and
7, and that the date area could not be filled. They were not blank — those
fields were **absent**. 70 of the template's 125 fields never reached the
documents, because `draftHouseholdLease` labels every resident with signer role
`tenant` while templates bind to `primary` and `co_tenant_1..3`. Nothing matched,
so every tenant field was pruned as an unused role slot. That drafter is the
normal invite path, so every household lease drafted through it carried this.

The thirteen were **deleted**, not voided — no signature existed on any of them
and nothing referenced them, and a voided row would sit in Blu's history forever
implying something had happened. Lot 1 was then reissued alone, as the real
packet: lease + installment contract (\$11,000 over 55 months, no down payment)
+ the SALE version of the lead-paint addendum. Delivered to Blu only.

**The packet now knows a sale from a rental.** A live home-sale contract means a
sale — it beats the ownership flag, because the home stays the park's on paper
until payoff. A tenant-owned dwelling means the landlord is renting land, so
neither lead-paint version is suggested. Everything else is a rental. That sorts
Country Acres exactly: eleven on installments, two who own their homes (Lots 6
and 17), no plain rentals yet.

**Disclosure slots: 45 categories, drawn from the acts.** GAM holds 49,161
statute sections across all fifty states — I had wrongly reported that corpus as
nearly empty, having looked at the structured-rules table (3 rows) instead of
the text. Every category was measured against it. The first pass found 28 and
Nic caught it missing the acknowledgement block on Blu's own lease; the second
pass found fifteen more, and the gap was framing rather than recall — the first
search asked what can be WRONG with a building, never what a landlord must TELL
or HAND to a tenant. Security deposit terms (41 states) and park rules (38)
outrank almost everything found first time. Park rules is the fourth line of the
acknowledgement Blu was reading.

A template also carries which transaction it belongs to (sale/rental/any) and
which state it was written for. Lead paint is federal, so one form travels;
Washington legislates the FORMAT of its disclosure statement and Minnesota,
Michigan, Ohio and Nebraska each prescribe their own, so those do not.
Most-specific-wins, and the general form shows as superseded rather than
vanishing. **Nothing anywhere claims a disclosure is required** — a test fails
on the words "required", "must" and "compliance" appearing in the API response.

**A name on a lease is never shortened again.** Blu saw "S-H-E dot dot dot". The
signing screen shrinks text, stops at a 6px floor and lets CSS hide the rest;
the PDF stamper sized on the box's HEIGHT alone and would have drawn the whole
name straight out past its box. The page he was reading and the page that would
be filed disagreed about what the lease said. Both now shrink on width, nothing
truncates, and below the floor it overflows visibly — because a name spilling
out of a box gets fixed and "She…" does not.

### Waiting on a decision from Nic
- **The rent-free charitable tenancy.** Nic's real scale worry: a large operator
  housing three or four families rent-free across many properties. Owner-use is
  now billed so that door is shut, but a landlord who simply never writes a lease
  (because there is no rent to collect) is invisible. A **$0-rent lease is fully
  supported and there are zero of them** — nobody knows it is an option. Offering
  "housed rent-free" as a tenancy type in onboarding probably recovers most of
  this without any enforcement. If detection is ever wanted: a charitable tenancy
  leaves no money trail at all, so the bank feed is useless — but utility
  consumption on a unit the schedule calls empty is close to un-fakeable, and
  GAM already holds the readings.
- **Blu is double-checking the template.** Nic's read: "I'm thinking he didn't
  save some of the boxes he edited." Two open items from his list are template
  AUTHORING, not code — the lot-number box sits off to the right of its line on
  one page, and the tenant-name box on Exhibit A was too narrow. The narrowness
  no longer truncates anything, but the box is still small. Nothing to do until
  he reports back.
- **The other twelve are ready to go** once Blu blesses Lot 1 — eleven as
  rent-to-own packets, and Lots 6 and 17 as lot leases with no lead-paint
  addendum, since those two households already own their homes.
- **Should the portal let a landlord set a unit `active` with no lease?** Nic's
  answer: yes — "active just means available", and blocking it would stop
  somebody taking an RV reservation. Settled; billing simply ignores the column. That is
  what happened at Springville, and it fed a wrong number onto GAM's own
  dashboard. The status asserts a tenancy that does not exist. Billing no longer
  reads it, so nothing is at stake financially — but it is a claim the product
  accepts without evidence, and it cuts both ways: the same control could mark
  occupied spaces vacant. Unchanged pending his call.

### Design items Nic holds
11. **Screening: check availability BEFORE the paid background check** — unit
    type, RV size, has-RV. Untouched. This is now the oldest untouched item on
    the list.
12. **On-demand bank balance refresh button** — four open questions from S650.
13. **Property settings questionnaire** — S648 idea, deferred.
14. **Work-trade redesign.**

### Larger, not started
15. **Native landlord + tenant apps** — S646 directive, wanted before solid
    contact with the 11k-unit PM.
16. **PM owner layer** — S644 priority one.
17. **Agents to ~99%.** Note Nic's standing instruction: do NOT spend time
    "fixing" demo-data drift in evals.

### Small, known
18. **PM `books.view` / `books.edit` reach no screen.** Grantable, honoured at the
    API, no PM portal surface. Zero PM scopes exist in prod.
19. **Three stale Resend suppressions** on GAM's own test addresses.
20. **Nancy Sheptock's three email-log rows** still carry her old address.

---

## Closed this session, do not re-raise

- **Curtis Clabough's hours.** Nic: "just leave Curtis at 20 hours. Blu can deal
  with that. Stop bringing Curtis up."
- **Oak Park's register Stays items.** Its prices were always on its units; the
  three buttons now exist.
- **Tenants as POS customers.** Already true — the picker has always unioned them.
  The register can now charge their saved card, which is what was actually missing.
- **Whether a pay link for a stay should be refused.** It should not; it consumes
  inventory like every other door.

## Payouts: the page now says what Stripe knows (Nic: option 1 + display; "if it's free, do it" → the Stripe notification too)

**What was wrong.** The dashboard showed "$413 catch_up", no bank, no company, and the $4,154.89 Nic paid out from the Stripe dashboard did not exist in GAM. Stripe HAD been delivering every payout event (six of them, all stored in `stripe_webhook_events`); the handler dropped each one because it looked the Connect account up on `users`, and Mountain View's account is stamped on the company (`landlords`). The `connect_payouts` audit table had never had a row.

**What ships (deploy 35).**
- `services/connectPayoutSync.ts` — `fileConnectPayout()` puts one Stripe payout on the landlord's page: updates the row GAM wrote when it initiated the payout (status, settled date, bank name + last four from Stripe's own record, company), or inserts a `stripe_dashboard` row when the landlord made it in Stripe. `syncConnectPayouts()` walks every Connect account's recent payouts (two free read calls per account) — runs right after each auto-payout run and nightly at 04:10 UTC (`jobs/scheduler.ts`). Run once by hand tonight: the $4,154.89 row is now on the books.
- `services/stripeConnect.ts recordPayoutEvent` — resolves the account via `users` UNION `landlords`; files the payout on the page the instant Stripe reports it (same routine); tells the landlord ONCE — only when the payout's status actually changes, because Stripe redelivers events. Test: `stripeConnect.test.ts` "once-only notice".
- `jobs/autoPayouts.ts` — auto-payout rows carry `landlord_id` (the company whose Connect account it is).
- `routes/disbursements.ts` — returns `bank_name`, `bank_last4`, `companies_on_account`.
- Landlord `DisbursementsPage` / `DashboardPage` — `DISBURSEMENT_TRIGGER_LABEL` ("Landed after the weekly run", "Paid out from Stripe by you"…), company name or every company on the account, bank + last four.
- Migration `20260922040000_payouts_say_where_they_went.sql` (bank_name, bank_last4, `stripe_dashboard` trigger).
- Stripe side: NOTHING new. The Connect listener `we_1TwmXE…` (payout.*, account.updated → api.goldassetmanagement.com/webhooks/stripe) already existed and works; no new endpoint, no .env change, no cost.

**Side effect to own.** Replaying the six stored events through the fixed handler (to backfill `connect_payouts`) re-sent three "Payout Sent" emails to realestaterhoades@gmail.com ($2,638.11 / $4,154.89 / $413.00). The three in-app notices were marked read. The once-only guard above means this cannot happen again.

## Disbursements page: one company filter, every card follows (Nic, end of S652)

Nic: "I want to see all of Oak Park's disbursements, total disbursed and total pending ... it blends both properties on the What you pay GAM card ... the account is completely — nothing should make one property supersede another."

- `DisbursementsPage.tsx`: a company filter at the top (every company on the account from `/landlords/me/entities`, "All companies" default, hidden for a one-company account). It drives the next-payout flow, the covered-cash-fees card, **What you pay GAM** (charges, debits, banks and the outstanding total are all cut to the chosen company), the two totals and the list. A payout still moving at Stripe (`processing`) counts as pending and reads "On its way" — the three Mountain View payouts sat in that status, which is why both totals read $0.
- API: `next-payout` rows, `gam-charges` charges/debits and `absorbed-manual-fees` rows now carry `landlord_id` so the page can cut them.
- **Not done — a separate pass:** Nic's "search everywhere" for anything that lets the first company on an account stand in for the account (`profileId` is used ~419 times across routes/services/jobs). That is an audit, by hand, in order, not a grep-and-replace.

Lot 15 (Mike Boyd) was drafted, then voided at Nic's instruction — Blu gets the figure from the previous owner tomorrow. Lots 6 and 17 (tenant-owned) went in the batch and stay sent. Deploy 36 = this page.

## Blu's two morning problems (2026-09-22) — both fixed, deploy 37

**"None of the packets included the installment contract."** They all did (document 2 of 9, status sent). Blu signed each lease, the done screen said "Signatures Submitted — the next party will be notified", and nothing led him to the other eight documents, which were waiting on HIS signature. Fix: `packageSiblings(documentId, forUserId)` now carries each sibling's signer status + token for the current signer; both signing pages show "Document N of 9 · M more for you to sign" in the header and the done screen's primary button is **Next: <title> →** into the next document that still needs them. Test: signingPackages "siblings carry the signer's own status and token". Until Blu opens a packet document again, the E-Sign page lists the eight per lot as "waiting on Blu Haws".

**"Late payment alerts, Day 2090."** The packets were drafted by script with no INVITE row, and the invite is the only place GAM learns "existing tenancy". Issuance read each lease's start date off the sheet (2018/2021/2023…) as a move-in and billed the first month there; the late-fee job (22:00) and the monthly run (05:00) piled on for MH 01 (rent 2021, $50 late fee, Sept rent, the August water $57.75). Only Blu was emailed (five alerts at 07:00); tenants got only their "Please sign" mails. Repair (`scripts/mattoon/load17_no_history_billed.ts`, applied): nine leases flagged `is_existing_tenancy`; twelve never-owed charges removed and ten invoices voided (unwindIssuedLease's own primitives; leases kept); the thirteen August reads stamped `billed_off_platform` — Blu billed that cycle himself, nothing bills from it, September measures from it and lands on October's invoice after he approves the run (Nic confirmed); invite rows (existing tenancy) written for MH 06 / 08 / 17 so their signatures issue correctly. Lot 15 needs the same invite row before it is drafted again. The completed August reading run now shows no cycle reads (cosmetic — they are the off-platform ones).

Rule for any future hand-drafted onboarding: write the `pending_tenant_intents` row (is_existing_tenancy=TRUE) BEFORE drafting, or the signature bills history.

## "Lease did not issue" ×4 on MH 06 (2026-09-22 08:25) — fixed, deploy 38

Blu signed four disclosure addenda before/around the lease; each landlord signature runs issuance, and an `addendum_terms` with no `lease_id` threw "Addendum has no parent lease_id" → critical alert. Packet siblings are drafted before the lease exists (`packetDraft.ts`), so none carried a lease id. `buildLeaseFromDocument` now: a packet document with no lease_id binds to the packet's lease if it has issued (stamps it, proceeds), otherwise returns `deferred` quietly; and when the packet's `original_lease` issues, every sibling is stamped with the lease. Backfilled: 77 sibling documents at Country Acres now carry their lease; the four alerts acknowledged. Test: esign "S652: a packet sibling waits for its lease, then binds to it". Signing the installment contract (`purchase_agreement`) is a standalone type — no build runs; the sale was linked at draft.

## Template features (Nic, 2026-09-22) + Blu's date entry — deploy 40

- **Choice group** (`field_type='choice'`): several boxes on the page, one group name (stored in `options`), pick ONE. Marked X (default), a check, or the signer's initials (`checkbox_mark`). Required means one box in the group, enforced as a group on the sign submit and counted once on the page. A child field can be "only shown if [box] is chosen" (`parent_option='chosen'`). Stamped like a ticked checkbox or an initial.
- **Fixed text** (`field_type='fixed_text'`): typed once on the template (`default_value`), printed as plain text on every document; landlord role, never required; the landlord can change it on one document by clicking the pencil while it is his turn (opens the text editor); the tenant only reads it (sign submit writes only your own role). Excluded from the review list.
- Landlord signing page's date entry is now the tenant page's three-box `TypedDateInput` (copied into apps/landlord/components) — the browser date box closed the editor per part changed.
- Fix found on the way: check-marked boxes threw at stamping (ZapfDingbats addressed as '3'); check marks are drawn as two strokes now. Test: pdfStamp "stamps choice boxes (X / check / initials) and fixed text".
- Editor sends `defaultValue` and `checkboxMark` on save (it never did; the API read them).

Still held for Nic's go: tenant packet email bundling (tenant is emailed per document as the landlord signs each — Shane got nine); a jump-to-any-document list on the signing page; re-drafting the unsigned Country Acres packets from the updated templates and re-sending in lot order.

## Packets: one invitation, any order (Nic, 2026-09-22) — deploy 41

- `services/packetRelay.ts`: `advancePacket(groupId)` — after any signature on a packet document, the next signer in order is invited ONCE, only when everyone ahead of them has signed every document in the packet; one email (link to the first document needing them), all their signer rows marked sent. `announcePacketIfComplete` — the "fully signed" note goes out once per signer when the LAST document completes. Standalone documents keep the per-document relay. Test: signingPackages "advancePacket — one invitation per packet".
- Both signing pages: the "Document N of M" line opens the whole packet — every document with its state for this signer (this one / needs you / you signed / not yours yet / done); click any that is theirs to open it. Order is the signer's choice.
- Tenants at Country Acres already invited per document before this change keep those links; nothing re-sends.

## Year field (Blu) — deploy 42
`field_type='year'`: template palette "Year (pick from a list)"; on the signing page a scroll list (next year back a century) that stays open until Save; stamped as text. Blu's installment contract "Year of manufacture" box (page 4) switched to it on the template; documents already drafted keep their text box until re-drafted.

## The paper is the record — installment contract terms (Nic, 2026-09-22) — deploy 43

Nic: "If I want my payment to be $19 for one hundred payments I need to type those in ... have the data tag be the correct label where the invoice will go out correctly no matter what I type in that box at signing time." Nothing derives from the invite or a sheet.

- Shared: sale columns (`sale_price`, `sale_down_payment`, `sale_monthly_payment`, `sale_term_months`, `sale_interest_rate`, `sale_first_payment_month`) are category **'sale'** — typed by the landlord, value-bearing (required on his pass), NOT locked. `sale_financed_amount` and the new `sale_final_payment_amount` / `sale_final_payment_month` are derived (identity). Migration `20260922050000_the_paper_is_the_record_final_payment_labels.sql` adds the two labels to both CHECKs.
- `services/homeSale.ts`: `saleTermsFromFields` / `resolveTypedSaleTerms` read the boxes as typed ("$19", "100", "10/2026", "October 2026"); `applySaleTermsFromDocument(docId)` runs on the LANDLORD's signature of a purchase agreement — writes the sale record (pending the tenant's signature, which starts billing), cancels a stale pending record on the unit, stamps the derived boxes. Typed terms are validated BEFORE the signature commits, so a bad box is fixed on the spot. Tests: `homeSaleTyped.test.ts`, signingPackages "what the landlord types … becomes the sale record".
- No record at draft anywhere now (packetDraft, the send flow, load16): a sale on the invite is a yes/no ("Selling them this home on installments"); any numbers given only prefill. The invite form lost its number boxes.
- Blu's installment contract template re-tagged: Monthly payment amount → Monthly payment; Number of monthly installments → Number of payments; First payment date → First payment month; Final payment amount / Final payment due date → the two derived labels (not required). The $450 was the box being tagged with the LOT RENT label; the 55 was right per lot (each contract had its own) but the box lost its tag when the template was re-fielded.
- Template editor: every box kind offers the data-label dropdown (signature → signature labels, initials → initial labels, year/choice/checkbox → text labels); "Fixed text" renamed **Template text**.
- Still waiting on Nic/Blu: the Template-text wording for the lead-paint form's "List documents below", then the go for the full re-draft (load20 then load16 --only 1,6,11,17,18,21,22,24,28,29,30).

## Post a payment (Nic, 2026-09-22) — deploy 45
"There's only a way to add a charge. There's no way to post a payment." Tenant page → **Payments** card → **Post a payment** (amount, cash/check/money order, check number, date received, note). `POST /payments/post-payment` → `services/postPayment.ts`: settles what is open oldest-first through the same manual-settle rules (cash free, first-payment waiver, pay-in-full — a short amount is refused), banks the rest on the active lease as paid ahead (`lease_prepaid_credits`, drawn down by the next invoice before it goes out), and writes ONE receipt (`tenant_remittances` — now allows cash/check/money_order, with `reference`, `notes`, `received_by`; migration `20260922060000_a_payment_posted_ahead.sql`). No credit is created. Profile returns `paidAhead`; the card shows "Paid ahead: $X — covers their next invoice." Tests: `postPayment.test.ts`.

## Banking tab: Sync asked "which business" (Nic, 2026-09-22) — deploy 47
The page carried the chosen company on its lists but not on its actions; on a two-company account, Sync / Disconnect / Categorize / Ignore / the deposit-match actions fell back to "choose which company." Fixed on both sides: a per-row action now reads its company OFF THE ROW (`scopeFromRow` in routes/bankFeed.ts — a connection or transaction belongs to one company; a stranger's is a 404), and the page sends the picked company on every call (books start date, the two panels' queries keyed by company). Test: bankFeedEntity "the row knows its company".

## Blu's packets refreshed; Shannon Gregory's email (2026-09-22) — deploy 48
- `scripts/mattoon/load21_refresh_unsigned.ts` (applied): every Country Acres document Blu had NOT signed — 63 across MH 01 (7) and 18/21/22/24/28/29/30 (8 each) — voided and drafted fresh from today's templates into the same packet at the same position with the same signers; his signed leases and the fully-signed lots (06, 11, 17) untouched. Installment boxes prefilled from the sheet; what he signs is the record. Tenants who had been emailed about old copies but never opened anything were set back to not-yet-invited so the packet invites them once when Blu finishes it. Then load18: eight continuation emails to Blu in lot order.
- Shannon Gregory (Oak Park MH 02, co-tenant): her account and signer line moved to rayvinmoonnyte136669@gmail.com by hand and her signing link sent there (set-password-then-sign email). Guard fixed in the invite email-change route: it blocked on the invite being resolved — which happens for the whole household when the lease issues on the landlord's signature — instead of on whether THIS person signed.

## The account is omnipresent (Nic, DIRECTIVE, 2026-09-22) — deploy 49
"You cannot be logged into two companies. You operate the companies. Your account is set aside of that... you're logged in omnipresent." The session now carries `homeLandlordId` (the company the account founded, refreshed with memberships in middleware/auth). `resolveLandlordTarget`: explicit wins; one company is that company; otherwise the account's OWN company — no more "You own more than one company. Choose which one." The only writes that must still name a company are a NEW property and a NEW bank link (`mustName=true`) — attributes of one LLC that are unwound by hand if filed wrong; the UI names them. Reads span all companies; per-row actions take the company from the row. Tests updated: expenses (write with no target lands on the founding company); property-create and bank-link still ask.

## Bank page split; deposit matching tightened (Nic, 2026-09-22) — deploy 50
Nic: "the bank feed and reconciliation need to be on a separate page." Bank page = two tabs: **Bank feed** (linked bank, balance, transactions) and **Reconciliation** (the month check, then "Deposits that may be rent" with its own company picker, and the cash-position panel). The deposit-matching panel had been dead for two-company accounts and, once fixed, took over the feed. Matching rule: a candidate is an exact amount match (one charge or a subset), a tenant's own report, or their name on the memo — the "could be a partial payment against a carried balance" guess is gone (it offered every deposit to MH 02). Tests updated: monthly P&L with no company named answers for the founding company; expenses likewise.

## Bank balance four days stale (Nic, 2026-09-22) — deploy 52
The 7:00 banking-day job asked Stripe to refresh the balance and read the account back in the same call — before the bank had answered — so it recorded the previous figure every morning (GAM: $206,520.82 as of 9/18; Stripe: $211,088.71 as of 9/21). `refreshBalance` now waits for Stripe's `balance_refresh.status` to leave `pending` (polls up to ~12 s) before writing, and records the account's stated balance (`current`) rather than the "available" subset. Sync refreshes the balance as well as transactions (best-effort). Wells Fargo 8739 re-read by hand: $211,088.71 as of 9/21.

## "GAM payouts" view on the bank feed (Nic, 2026-09-22) — deploy 53
The $4,154.89 and $413 payouts were in the feed (imported at midnight, matched to their disbursements) but no view showed matched rows. Bank feed tab now has **GAM payouts** beside Needs review / Categorized / Ignored.

## Old signing links forward; invite acceptance stamps (2026-09-22) — deploy 54
Blu kept opening links from the earlier emails; every one pointed at a document voided by the 2:25 PM re-draft and answered 410. `authOrSignerToken`: a token for a voided document now forwards to its replacement — same packet group, same slot, same signer — and only a document with no replacement is 410. Both signing pages show the server's reason instead of a generic "Invalid Signing Link". Shannon Gregory: the accept step stamped only invites still waiting to draft, so an invite already resolved by the landlord's signature never showed accepted on the front desk; every non-cancelled invite of the person is stamped on accept (hers stamped by hand).

## Bank feed is the whole log (Nic, 2026-09-22) — deploy 55
"The transaction log of the bank account is all money going in and out." The feed opens on **All transactions**, newest first, GAM payouts included and labelled "matched to its disbursement — never counted twice"; Needs review / Categorized / Ignored are filters over the same log; a row's controls follow the row's own state. The separate "GAM payouts" view (deploy 53) is gone.

## Deploy 56 — Blu's installment contract would not submit (2026-09-22 ~16:40)

**What Blu saw:** Review & Sign on the MH 18 installment contract, page reloads, no message. Four POSTs, every one a 400, log showed only the status code.

**Cause (reproduced, not guessed):** cloned the document, signers and fields into `gam_test` and replayed the submit in-process — `"The installment contract needs the number of payments."` The submit route's field SELECT did not fetch `lease_column`, so the typed-sale-terms pre-check saw no tagged boxes at all. Every installment contract was un-signable since the pre-check shipped (deploy 43/44).

**Fixed and shipped:**
- `lease_column` selected; regression test proven to fail without the fix (`esign.test.ts` "installment contract reads the typed terms").
- Both SignPages keep the review sheet open on a rejected submit and print the server's reason ("Not submitted. …") instead of a lost toast.
- Error handler logs every non-GET 4xx with its reason (`request rejected (4xx)`).
- Blu re-saved the installment template fields at 16:20 (dropped the untagged "Late fee initial flat/percent" boxes, added co-tenant initials). Re-drafted the 8 unsigned installment contracts (MH 01, 18, 21, 22, 24, 28, 29, 30) from the current template in place — same packet slot, same signers, sale terms carried — with `load21 --purpose installment_sale --apply`. Old links forward to the new copies; no new emails needed. MH 11 (Blu already signed) untouched.
- Payments page: one person + one company = ONE outstanding row and balance across their leases (Billy RV 34 + 35); Record payment sends `settleHousehold: true`; credits are the household pool.
- Issue credit: type a name / space / property, pick from matches (no more spot scroll).
- Unit page: "Turn off for this lease" beside every billed utility; route now allows switching a lease-billed utility off as a recorded addendum (was a 409 — Billy's trash had to be written by hand).

**Not built (asked S652):** credit to a returning POS customer. It is a new mechanism: a `pos_customer_credits` table, `POST /tenant-credits` accepting `posCustomerId`, register auto-apply as a "Store credit" discount line, parity for the business POS. ~half a day; needs a go.

## Deploy 57 — one reminder per packet, one late-rent digest per landlord (2026-09-22 ~17:15)

**Why Blu got ~50 emails at 16:30:** the signing-reminder job (every 15 min) nudges a landlord once, two hours after a document is sent — per DOCUMENT. The 8 installment contracts re-drafted at 14:25 plus the other unsigned documents in those packets came due together: 54 reminders in one tick, 6 more at 16:45. Not the re-draft itself (that sent nothing); the reminder pass behind it.

**Shipped:**
- Reminders are per signer per PACKET: one email, "your N documents for Unit MH 18 — Country Acres", link opens the first document and the sign page walks through the rest; every document in the packet is stamped so the cadence and the five-reminder cap count packets. Same for renewal reminders. Test: `esignTimeouts.test.ts` "one reminder per signer per packet".
- 7am late-rent alerts: ONE digest per landlord (table of tenant · unit · owed · days late, total in the banner), category unchanged so the email dashboard still sees them. The per-tenant sender still exists but nothing calls it. Test: `email.test.ts` "sendLatePaymentDigest".
- Verified the Day-2090 alerts are gone: no open rent charges before June 2026 remain on Blu's account after the load17 repair.

**Flagged, not changed (needs Nic):** the 7am job adds 1 to a tenant's `late_payment_count` EVERY morning a balance is still open, so a tenant 30 days late is counted as 30 late payments. It should count once per late charge. Needs a marker on the charge (migration) and a decision on what a "late payment" is for screening purposes.

## Deploy 58 — "late payments" counts charges, not mornings (2026-09-22 ~5:40 pm)

**Nic's call (option 1):** the admin "Late Payments" number derives from the credit ledger. The `tenants.late_payment_count` column was bumped every morning a balance stayed open (thirty days late = thirty late payments); the 7am job no longer touches it and nothing reads it. Windows stay as they are (grace / 3 days / 15 days past grace). The stamps stay: every ledger event carries due date, paid date and grace days, so a window change can rescore full history.

**Found and fixed on the way:** only Stripe settlements wrote to the credit ledger. A check or cash payment recorded at the desk, however late, was never a late payment anywhere — and the new counter would have missed every one. `settleManualRentPayment` now writes the same event, same tier, `landlord_self_reported_with_evidence`, with the method and check number as evidence. Tests: `payments.test.ts` "a check recorded late writes the same ledger event", `tenants-admin-views.test.ts` counter-from-ledger.

**Open (needs Nic):** past desk settlements from before this deploy are not in the ledger. Backfilling them is a retroactive change to real tenants' credit history — numbers in the session notes; not done without a go.

## Deploy 59 — credit history rules: onboarding month, work trade, every method (2026-09-22 ~6:05 pm)

**Nic's rules (DIRECTIVE):**
- The onboarding month (month of the first rent charge on an existing-tenancy lease) is never negative: on time / within grace = good mark, late = nothing. Enforced inside `emitPaymentSettledEvent`, so every settlement path obeys it.
- Work trade counts as on time: a line covered by approved hours at month close writes `payment_received_on_time` (gam_workflow_auto). A deficit billed afterwards gets its own due date, so paying it by then is on time on its own.
- Every payment method counts (deploy 58 added desk cash/check/money order).
- Windows unchanged (grace / 3 days / 15 days past grace). Stamps kept: due date, paid date, grace on every event.

**Backfill applied (positive only):** 14 desk payments from September paid within grace → `late_grace` good marks for Russ Fuller, Jonathan Covey, Coreen Covarrubias, Henry Cisneros, Illyana Gonzalez, Jeremy Parker, Julie Kenyon. 55 late desk payments and 8 prior-arrangement rows left out — nobody gained a late mark. Script: `src/scripts/backfillDeskLedger.ts` (dry run by default).

Tests: `creditLedgerEmitters.test.ts` "onboarding month is never negative", `workTradeSettlement.test.ts` on-time event on a covered rent row.

## Deploy 60 — sign page reset, lease packets, front desk dates (2026-09-22 ~7:00 pm)

- **Sign page "4/2, no boxes" (Blu):** the route changed the token but React kept the component, so page 4 of the installment contract carried into the two-page lead-paint disclosure. Every per-document state (page, boxes, stage, error) now resets when the document changes. Both landlord and tenant SignPages.
- **Leases tab = the packet (Nic: "I only wanted to see that package — what was sent to who... and what they signed"):** a row expands under the tenant to every document drafted with that lease (`GET /leases/:id/documents`: the lease document plus package-group siblings, never voided): title, when it was sent, each signer's answer (signed + date / not signed / declined), and Open (signed copy once complete, draft until then). Nothing else in the expansion. Jay Jones' one-page "lease" was the generated summary shown when a packet is not complete.
- **Front desk "owes Sept 30":** the October 1 due date parsed as midnight UTC, which is the evening before in Phoenix. Dates are read as calendar dates now. And a bill that is not due yet no longer puts anyone in "Owes" — Nic: "it shouldn't show until it's due."
- **Register stays (Mountain View) — NOT changed (Nic: "don't do anything with the point of sale right now").** Finding only: a stay item has no price of its own by the S652 rule; the SITE's rate is the price ($49 / $269 / $589 on all 53 sites) and the server refuses a stay sale without a site. The cart shows $0.00 until "Pick a site and dates" is answered. The public booking site quotes from the unit rate (verified live: 2 nights = $98 + tax) — nobody books free online.

## Deploy 61 — "Send an addendum" from the lease packet (2026-09-24)

**Blu's deposit question ($0 on page 1, $450 on page 5):** not a tag error, not derived from rent. Page 1's tagged `security_deposit` box prints what GAM holds ($0 — onboarding leases bill no deposit; Blu physically holds none). Page 5 is his Exhibit A whose PDF TEXT says "Security Deposit: $450"; the only boxes there are the untagged five-year rent history he typed (450/450/400/350/300) on every lease. Nic: leave the existing leases; he corrects contradictions by addendum. No change made.

**Addendum sending (built):** the `addendum-terms` route existed and no screen used it. Leases tab → expand a name → gold "Send an addendum": pick a template (any of his except installment/work-trade), title prefilled, "Everyone on the lease" (agreement) or "Notice only"; drafted onto the lease and sent at once — landlord signs first, tenants invited by the relay after. Appears in the packet list. Blu's two new addendum templates are saved with purpose 'lease'; they work from the button as-is.

**Answered, not built (Nic: curiosity):**
- One-signature property-wide notice with per-household acknowledgement: not built. The batch route drafts one document per lease, each needing his signature. ~1 day if wanted.
- Mountain View / Oak Park leases pre-date packets (packet = the signed lease only); adding state-required documents today = the same button per lease, "Notice only".

Nic's baby was born 2026-09-24; he is away. POS: untouched by instruction.

## Deploy 62 — addendum send fixed and sent for Blu; Leases row actions collapsed (2026-09-25)

**Blu's "Draft and send" red error (Country Acres Addendum Troy — MH 22):** the addendum route built every signer at signing position 1, so the send step refused it: "The landlord must sign before all other signers — no signer may share the landlord's signing position." (Found straight from the 4xx reason now in the log — deploy 56 paid off.) Fix: landlord = position 1, tenants 2, 3… like every other drafting path. The draft he made at 1:15 pm was repaired by hand (primary → position 2) and sent through the real send route as him at 4:06 pm; "Please sign" went to hawshomes.llc@gmail.com; Troy is invited once Blu signs. Test extended: signer order + a successful send.

**Leases page too wide (Nic):** eight row buttons ran off the right edge. Now three: Details, a **Charge** menu (Bill a fee · Charge an amount · Recurring add-on or rent change · Carried balance) and a **Change** menu (Move to another space · Move out · Hibernate/Resume). Discard stays on drafts. No modal changed; the same actions, fewer buttons. Nic's further thought — fold "bill a fee" and "charge an amount" into ONE form with a recurring toggle — not done; a design decision for him.

MEMORY.md index trimmed under its size limit (entries ≤128 chars).

## Deploy 63 — the first billing cycle is the floor; Country Acres history erased; April off MH 05 (2026-09-25)

**Cause of "Country Acres overdue":** (1) the nightly invoice job never read `properties.first_billing_cycle` (Oct 2026); on the 23rd it billed September for 8 households and the late-fee job added $50 each on the 6th-of-month rule. (2) John Sheptock's installment contract was typed with its true start (Jan 2021, 120 × $200); on his signature the sale engine billed 69 months, $13,800. Eight more contracts carry real historical starts and would have done the same.

**Shipped:** the property's first billing cycle is the hard floor on every bill's DUE month — nightly invoices (`invoiceGeneration`, filter on candidate due dates), home payments (`billDueHomeSaleInstallments` stamps earlier installments `settled_off_platform_at`, never bills them, counts them paid in `reconcileHomeSaleContract`; migration 20260925180000). Nic: the floor is on the cycle, not on consumption — the Oct 1 invoice still carries September's utilities (arrears), untouched. New property: "First bill from GAM" is a required month on the add-property form and the onboarding property step (defaults to next month); the API defaults it when a caller omits it. Tests: invoiceMoveInMonth "first billing cycle is the floor".

**Data (Nic: "completely erase them, they are not real — a void is for a mistake made ON platform"):** 8 September invoices + 16 charges (8 rent, 8 late fees) at Country Acres DELETED; John's 69 pre-October home payments DELETED and the 69 installments stamped settled outside GAM → contract reads 69 paid / 51 to go. Now open at Country Acres: MH 06 and MH 17 October rent only.

**April Hendrickson (Mountain View MH 05):** never lived there. Her signer row and 17 fields removed from the lease document, her lease_tenants row voided, her invite cancelled; the document completed with `completed_at` = Ruben Negrete's signature (Sept 16, 3:08 pm), executed PDF re-stamped; lease `signed_by_tenant` set.

**Mountain View tax:** both rows 6.35% → 6.60% (Santa Cruz County: 5.6% state + 1.0% county retail; transient lodging 6.60%). 6.35% was Yavapai's rate.

**Not built, Nic's call pending:** returning-resident background-check bypass (options given); register decimals / clear-cart / stay-button price (he is thinking about site pricing); one-signature property notice; POS customer credit.

## Deploy 64 — first bill waits for the cycle; register base rate, decimals, clear-cart; debit test armed (2026-09-25 evening)

**Deploy 63 (floor) shipped on its second run** — API restarted 4:58 pm with the floor; the landlord front end's Vercel alias lagged ("still serves index-CglFOWsJ.js"), redone here. First run failed 4 home-sale tests because gam_test is rebuilt from schema.sql and I had ALTERed it by hand — process fix in memory (migrate → dump-schema → tests).

**Nic: "We are not in October. There shouldn't be open bills at all."** The move-in bundle made an existing resident's first invoice at signing (weeks early, no meter reads; Curtis got an empty October statement Sept 23). Now: an existing tenancy whose first cycle is in the future gets NO invoice at signing; the nightly job makes it when the cycle arrives, with the month's utilities. Country Acres' two premature October invoices (MH 06, MH 17) and their charges ERASED. Open charges at Country Acres: none. Test: invoiceMoveInMonth "signing an existing resident before the first cycle makes no invoice; the cycle does".

**Register (Nic's go):** stay buttons show the property's base rate = cheapest site of that length ("$49 from"); the cart line starts there and takes the chosen site's rate when picked (`base_rate` on GET /pos/items). Quantities take two decimals (10.5 gallons). Clear: a named sale (tenant or POS customer) is held as a ticket; an anonymous one is dropped and the open-tab banner no longer resurrects it. Both registers byte-identical.

**Fee debit test (Nic: "test that flow, PNC"):** both companies' bank-feed links are the same banks as their Connect payout banks (Oak Park PNC ****9677, Mountain View Wells Fargo ****8739); the debit payment method is minted from the feed link on first use, so ONE link already serves payouts and debits. Oak Park's threshold lowered $100 → $10 for the test; the sweep runs 8:30 am Phoenix and should pull $48 + $6 bank cost. Risk: if the feed link lacks the payment_method permission the sweep logs "no usable bank link" — check the 8:30 log. Restore the threshold after.

**Stripe $198.50 vs ledger $218.87:** reconciles. Stripe = Sept net $190.58 + pre-Sept $7.92. The ledger books margins from ESTIMATED processor costs; Stripe's actual fees + network costs ran ~$19 higher this month (plus ~$1 pre-Sept). The month-end true-up (already ran a partial +$33.11) posts the difference on the 30th. Nothing left Stripe.

**Returning-resident (Nic chose option 2):** not yet built — designed: invite modal gets "This person has lived here before" attestation (replaces the free "no screening" unit-invite path outside the onboarding window); recorded on the intent (screening_waived + attested); rolling-365-day count per property capped at 25% of unit count → over the cap = admin flag, landlord never sees the count. Next deploy.

**Still awaiting Nic's go:** schedule row label + scroll layer; tenants page payment-health column + work-trade = 100%; maintenance categories per property (option 2).
