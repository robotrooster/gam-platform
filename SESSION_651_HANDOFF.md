# Session 651 Handoff — 2026-09-20

## Where things stand
16 commits, deployed and verified — **all surfaces in sync**, suite green at
7,619 tests.
Mattoon is loaded into production. **No tenant anywhere was emailed** except
Rashawn Bump at Oak Park, which Nic authorised in the moment.

---

## Corrections Nic made, and what they changed

**"ACH is $6 flat."** I had written the fee-debit's bank cost as 0.8% capped at
$5 — a number off a processor's public rate card that has never been a GAM
number. It now reads `PROCESSING_FEES.ACH_FLAT`, and the invented rate is gone
from the comments rather than preserved as folklore. Worth seeing what it
exposes: $6 against Oak Park's $48 September fee is 12.5%, which is the argument
*for* the threshold, not against it.

**"That's not a landlord choice to fucking pay us."** I had put a consent toggle
on the fee debit. Gone — no authorise/revoke endpoints, no switch in the portal,
and the sweep considers every landlord who owes. The fee is owed for running the
park however the rent arrived; netting is preferred because it moves no extra
money, not because anyone granted permission. A switch that turns off the only
remaining collection route makes an all-cash park free to run.

**"$130 is between the two properties."** It was two separate landlords —
Mountain View $82 for 41 spots, Oak Park $48 for 24 — each netting from its own
payout. I had written it as one bill out of Mountain View, inside a comment
about not blurring numbers.

**"There was no renter pool."** I "fixed" the landlord-side applicant search and
called it the renter pool. Different direction entirely, and `application_pool`
is empty. The real thing is a person looking for somewhere to live: from the
address on their ID, places near them, in miles, expandable. Built.

**"We don't want to filter it to parks."** The pool shows anywhere a person
could take a month-to-month or long-term lease — apartment, house, lot, site,
long-term motel room, all the same. Nightly/weekly-only operators drop out.
Read off `units.lease_types_allowed`, deliberately a property of the UNITS:
Oak Park is a motel that also houses long-term residents, and any rule keyed on
property type would have had to guess about it.

**"Register price should be its own thing."** I proposed pricing a register stay
from the unit's rate card, on the theory that Mountain View's $49 POS item and
its $49 nightly rate were a contradiction. They are not — one is the register's
price at that property, the other is the booking site's. Nothing in the register
stay code reads a rate card.

**"Stop fixing demo data that means nothing."** I pivoted from register stays to
chasing a seed-data balance from $2,330 to $3,095. Reverted, uncommitted.

---

## Built this session

**The fee debit for all-cash properties.** Fires when there is no payout to net
against and the balance crosses the threshold. The $6 transfer cost is its own
line item, so the statement reads two numbers instead of one lump. Charges mark
paid only on settlement — ACH bounces days later, and a fee marked paid on
submission would let next month's accrue on a debt that never cleared. A bounce
is not auto-retried. The GAM-charge ledger now shows on Disbursements; it was in
the database and on no screen at all, which is where the dispute starts.

**Queued agent turns say so.** `queuePositionMessage` had zero callers since
S628 — the copy existed and was shown to nobody, so a queued person saw a typing
indicator run for ninety seconds. Both widgets now show it in place of "is
typing", after a six-second delay so an ordinary turn never flashes a wait that
was not real.

**The renter pool.** Suspended tenant portal: Find a place + Profile, nothing
else. The moment a landlord signs them it stops firing on its own. Nic's New
York case is a test — nothing in range, and the nearest named, because an empty
screen reads as "GAM has nowhere to live". Also found and fixed: properties
geocode once at creation, fire-and-forget, so a failure is permanent and silent.
Country Acres had its whole address typed into `street1`, so the lookup carried
Mattoon and 61938 twice and resolved to nothing — invisible to every renter with
no symptom anyone would see. Retried nightly now, and backfilled.

**Mail that never arrives.** Three separate faults, one chain:
- Bounces were captured but only ever alerted GAM admins. The landlord — the one
  person who can ask a tenant how their address is spelled — saw nothing.
- A SUPPRESSION fires no event at all. Once Resend gives up on an address, every
  send is accepted, given a message id, and discarded. Thirteen emails to Rashawn
  Bump vanished that way over three weeks, every one logged 'sent'.
- GAM now mirrors the provider's suppression list nightly, refuses to send to a
  dead address, and records it 'undeliverable' instead of 'sent'.

**Register stays land on the Master Schedule.** `pos_items.stay_unit` is night,
week or month and quantity multiplies it. The cashier supplies only what cannot
be derived; the site list is what is actually free for those dates. The booking
is written inside the sale's transaction behind a per-site lock, so a site that
turns out to be taken rolls the money back.

**deploy.sh was missing admin-ops and books.** Both live on their own domains,
both shipped by nobody. admin-ops had been stale since its S650 login change.

---

## Country Acres (Mattoon) — loaded

Blu Haws (TruBlu Management LLC) is the sole owner; "Jeff" on the Park Info
sheet is the seller from before closing. Source is sheet 1 of
`Illinois Trip.xlsx`. Scripts and a fuller note live in
`apps/api/src/scripts/mattoon/`.

| | |
|---|---|
| Lots live / retired | 31 / 16 |
| Occupied | 13 |
| Tenant accounts created | 13 (no invite token, no email) |
| Lease documents drafted | 13, all pending Blu |
| Installment contracts | 11 drafted, then **voided** — see below |
| Water meters / readings | 13 / 26 |
| Readings flagged for a read | 3 |
| First billing cycle | October 2026 |

Lots 12–14 and 25–26 exist and are retired — the city removed them, and a gap in
the numbering would otherwise read as a missing record. Lots 5 and 27 are out of
order pending a trailer rotation.

**The installment contracts had to be voided, and that is the useful finding.**
Nic asked me to "double check that when they have a lease and a rent to own
contract, that everything is billed correctly." It would not have been. A signed
purchase agreement calls `activateHomeSaleContract`, which looks for a
`home_sale_contracts` row on that document; drafting the agreement alone creates
none, and `createHomeSaleContract` cannot run yet either because it needs the
tenant's LEASE as its billing anchor. Signed by everybody, billed nothing, and
silent about it. The right order — which `POST /home-sale` already does in one
step — is lease signed → contract created → agreement drafted → agreement
signed → installments billed.

**This constrains the signing bundle.** Nic's intent is one packet, two
documents, two signatures. That works for a tenant who already has a lease; it
cannot work on a brand-new tenancy. Either the bundle sends in two passes for
new tenancies, or `home_sale_contracts.lease_id` — already nullable in the
database, though not in the TypeScript input — gets filled when the lease
completes. Worth a decision before Mattoon's leases come back signed.

**Water reconciles to the cent.** Every row is (current − prior) × $16.50,
$572.55 across the park. The sheet records 1044.9 where a seven-digit face reads
1,044,900, so a unit is a thousand gallons and the rate is $0.0165/gal, stored
as `reading_multiplier` 1000 so the person walking the route writes down the
face. Lots 21, 22 and 24 read identically on both dates — three occupied homes
using no water for a month is not credible, so they load flagged rather than
estimated.

---

## Illinois — what the law says about billing that water

Not legal advice, and worth an hour of counsel before the first invoice. What
the statute actually says:

- **765 ILCS 745/12(c)** — a lease may not require a tenant to pay **any fee not
  specified in the lease**. The water rate and the method have to be *in* the
  lease. This is GAM's own `gam-lease-is-law` rule, in statute.
- **745/12(a)** — no late fee without at least **5 days** past the due date.
  Country Acres is set to exactly 5. Compliant, and now pinned by data.
- **745/12a** — a lease may not **require a tenant to buy a home from the park
  owner**, nor make it a condition precedent to the lease. The lease and the
  installment contract are bundled for signature; they must stay legally
  separable, and the purchase optional. Worth raising with counsel given the
  bundle presents them together.
- **745/(d)** — **90 days' notice** of any rent increase, and it cannot take
  effect until 90 days after the notice.
- **Markup**: Illinois permits submetering but restricts what a landlord may
  charge to the utility's actual cost plus reasonable administrative fees.

**The number to check.** Mattoon's own 2026 volumetric water rates are roughly
$3.10–$7.60 per 100 cubic feet (748 gallons) — about $4–$10 per 1,000 gallons —
plus a monthly base charge. City sewer is $7.54 per 100 cf, but Park Info says
the park is on **private septic**, so it likely pays no city sewer. That makes
$16.50 per 1,000 gallons plausibly **above** what the park pays for water.
Blu should put his actual water bill next to it before the first invoice.

Sources: [Mattoon water rates 2026](https://mattoon.illinois.gov/wp-content/uploads/UPDATED-CITY-OF-MATTOON-WATER-RATES-2026.pdf) ·
[Mattoon sewer rates](https://mattoon.illinois.gov/government/finance-department/sewer-rates/) ·
[765 ILCS 745](https://dph.illinois.gov/content/dam/soi/en/web/idph/files/publications/mobile-home-landlord-and-tenant-rights-act-printable-5-31-18.pdf) ·
[Illinois submetering summary](https://umsbilling.com/illinois-submetering-and-ratio-utility-billing-laws/)

---

## Needs Nic

1. **Send the 13 leases to Blu?** They sit drafted and unsent. Firing the
   signing requests puts 13 emails in his inbox; one note pointing him at his
   queue may land better. Nothing reaches a tenant either way until he signs.
2. **The bundle question above**, before those leases come back.
3. **The water rate** against Blu's actual bill, per the Illinois section.
4. **Onboarding window expired 9/11** with onboarding never completed. Left
   alone — extending it moves GAM's own revenue timing.
5. **Oak Park has no Stays items**, so it cannot sell a register stay until
   somebody adds them at Oak Park's prices.

## Closed after Nic read the first draft
- **Nancy Sheptock** had accidentally created a landlord account and was sent
  two landlord onboarding emails. Profile removed, role corrected to tenant,
  her email history kept. Lot 1 is loaded — she is the account holder, John is
  the occupant.
- **Curtis Clabough** stays off a work-trade agreement by decision; Blu applies
  a credit as needed until he settles what he wants.
- **The 5-day late-fee grace** was never a problem — the statutory minimum is 5
  and the property is set to 5. I listed a pass among things needing attention.

## Still on the list
Property settings questionnaire · work-trade redesign · native apps · agent
evals · the three design items Nic holds (reservation form follow-ups,
screening-before-payment, on-demand balance refresh).

---

## Deploy status
Everything shipped and verified: API, landlord, tenant, admin, pm-company, pos,
marketing, storefront, **admin-ops and books** — the last two for the first time,
having been live on their own domains and shipped by nobody.

books failed its first attempt with `project_settings_required`: it was linked
to a Vercel project but its settings had never been pulled locally, so
`vercel build --prod` had nothing to build against. Fixed with
`vercel pull --yes --environment production`, which writes `.vercel/project.json`
and the production env file. It deploys normally now.

Live as of this deploy, and not before it: the 08:30 fee-debit sweep, the 04:35
mail-suppression sync and the send-path refusal, the 03:50 geocode backfill, the
renter pool, the queued-agent notice, and register stays.
