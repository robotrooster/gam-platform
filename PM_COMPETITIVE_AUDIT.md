# What property management companies use that GAM does not have

Written 10/27 for the 11,000-unit PM conversation. The question Nic asked was
"what do PM companies use that we don't have" — so this is a gap list, not a
feature list, and it is honest about the things we would be asked for on day
one and could not show.

Measured against what the big four actually ship (AppFolio, Buildium, Yardi
Breeze/Voyager, RentManager) and what the buyer's guides treat as table
stakes.

---

## The short version

GAM is **ahead** of these platforms on money movement, on the resident
experience, and on anything to do with RV/extended-stay operations. It is
**behind** on three things a PM company will ask about in the first meeting,
and all three are compliance paperwork rather than product:

1. **Renters insurance** — we do not track it at all.
2. **Vendor certificates of insurance** — a column exists and nothing on the
   platform reads or writes it.
3. **A vendor's own login** — vendors have no portal; everything about them is
   entered by staff.

Everything else on the standard checklist we either have or have deliberately
done differently.

---

## 1. Renters insurance — MISSING ENTIRELY

Every one of the four requires it of residents and tracks compliance: policy
number, carrier, coverage amount, effective and expiry dates, proof on file,
and a report of who has lapsed. Several sell their own policy alongside it.

GAM has **nothing**. The words appear once in the whole codebase, in a credit
formula's list of events that could be scored — an event nothing emits.

Why a PM company cares, in their words: an uninsured resident's kitchen fire
is the owner's claim and the manager's phone call. A lapse report is how they
stay out of it.

**What it would take:** a policy record on the lease, proof upload (the
document machinery already exists), an expiry watch, and a compliance list per
property. Roughly the shape of the deposit-interest work.

## 2. Vendor certificates of insurance — A COLUMN NOBODY READS

`contractors.insurance_expiry` and `contractors.insurance_verified` exist in
the database. **Nothing in the codebase writes them, nothing reads them, and
there are zero rows.** There is no expiry watch, no block on assigning work to
an uninsured vendor, and no report.

For a PM company this is a liability question, not a convenience one: sending
an uninsured contractor to an owner's property is the exposure they are paid
to prevent. Buildium and AppFolio both track it; one of the buyer's guides
lists certificate-of-insurance tracking as a reason to pick a platform.

**What it would take:** less than renters insurance — the columns are there.
A proof upload, an expiry watch, and a rule about assigning work.

## 3. A vendor portal — NOT BUILT

AppFolio, Buildium and RentManager all give the vendor their own login: see
assigned work orders, accept or decline, upload photos and an invoice, get
paid, and keep their own W-9 and insurance current.

GAM has maintenance workers as STAFF with scoped logins, which is the same
idea for an in-house crew and not the same thing for a third-party vendor a PM
company uses across forty properties. Today a vendor's invoice is entered by
staff.

**Worth saying plainly:** this is the biggest of the three in build terms, and
the one a PM company notices soonest, because their vendors are the ones who
complain.

---

## On the standard checklist, and we have it

Listed because the first meeting will go through them and the answer is yes:

- **Owner statements and the owner portal.** Built as the PM owner layer.
- **Trust accounting and bank reconciliation.** Built, and stronger than
  theirs: every money table is journaled and the books rebuild from the
  journal, which none of the four do.
- **1099s.** Present across the books.
- **Work orders, approvals, an approval threshold.** Built.
- **Inspections, entry requests, violations, evictions, delinquency.** Built,
  several with a resident-facing side the others do not have.
- **Budgets.** Present.
- **Document storage per property and per company, with e-signature.** Built.
- **Resident and owner portals, applications, screening.** Built.
- **Utility billing, RUBS, sub-metering.** Built, and well past what they do —
  this is an RV/MH park requirement they treat as an add-on.
- **A PM company as its own entity, with staff, fee plans and its own cut of
  the rent.** Built.

## Where GAM is simply ahead

Not a gap list, but the answer to "why you and not AppFolio":

- **Every cent moves through the platform** and is batched, netted and paid
  out on one schedule. The others leave money movement to a processor and
  reconcile after.
- **The money products** (FlexDeposit, FlexPay) have no equivalent at any of
  the four.
- **RV, extended-stay and nightly operations** are first-class: bookings, site
  moves, out-of-order sites, prepaid stays, lodging tax. The four are built
  for apartments and bolt this on, badly, if at all.
- **A POS and a register** at the property. None of them have one.
- **The change journal.** Every money row's history is kept forever and the
  books are rebuilt from it. This is an auditor's answer the others cannot
  give.

---

## What I would do about it, in order

1. **Vendor certificates of insurance.** Cheapest, and it closes a liability
   question rather than a convenience one. The columns already exist.
2. **Renters insurance.** Bigger, and the one they will ask about first.
3. **The vendor portal.** Biggest. Worth scoping only once the PM deal is real
   enough to say how their vendors actually work — building it on a guess is
   how it gets built twice.

None of the three blocks the deploy, and none of them was promised to anybody.
