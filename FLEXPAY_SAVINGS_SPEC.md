# FlexPay: eligibility, what the resident is asked, and what they are shown

Spec from Nic, 10/26 (revised the same evening). Not built yet.

## Nobody opts in cold — eligibility is earned

A resident cannot ask for FlexPay until GAM has enough history to know
whether it helps them. There are **three separate gates**, and they are not
the same thing (10/26, Nic, correcting an earlier conflation):

**Two doors to the initial interest survey** — either one opens it:

1. **Two months with a late payment.** Being late gets them there *sooner*:
   *"they can get on it sooner if they're late, if they verify their income."*
2. **Three months of clean history.**

Either way the survey is the same voluntary income question, and either way it
leads to *finding out whether they are eligible*, never straight to enrolling.

**Six months of clean history** is a different gate entirely: it is how
someone gets back in **after a failed pull**. (CLAUDE.md records a 90-day
re-enrollment lockout from S512 — the two need reconciling: six clean months
is the longer bar and probably supersedes it.)

**Lateness is tracked separately from whether a fee was charged.** Nic: *"even
if the landlord waived the late fee, we need to track, boom, this person was
late."* A waiver is the landlord's discretion on one day; it is not evidence
the resident paid on time. So the counter is "was this bill late", not "did a
late fee post".

Because of these gates, **the no-history case never arises** — the earlier open
question about a brand-new resident with nothing to compare is closed.

## Asking about income

The survey is voluntary, disclaimed, and GAM's own — not the landlord's, and
with no bearing on tenancy. Nic's framing: *"the survey is voluntary. We want
to ask you some questions about income. It has nothing to do with your
landlord. This is just for the platform itself."*

What is actually worth a lawyer's eye is **not the question** — it is that
FlexPay eligibility is restricted to SSDI/SSI recipients, which is a service
decision made on income source. That restriction predates this spec. The
question itself is the ordinary way such a program identifies who it is for,
and the voluntary + disclaimed + no-tenancy-consequence posture is the right
one. Declining to answer must never produce an adverse consequence.

## Proof of income

Not possible today — the application and background-check flow has no way for
an applicant to upload proof of income. Nic: *"We probably need to start
adding that."* Separate build item.

## What the resident is ASKED

**When their money arrives. Not when they would like to pay.**

Nic: *"We don't ask them when they want to pay. If they get paid on the second
Wednesday, they cannot choose the third Wednesday just for the heck of it."*

So the question is "when does your disbursement land", and the pull day and the
benefit-Wednesday column are **derived** from the answer together with their
lease. This replaces today's model, where `tenants.flexpay_pull_day` is a free
choice of any day 1-28.

## What the resident is NOT shown

- **No price table.** Nic: *"We don't want to show tenants the table."* They
  are told their own price, derived.
- **No comparison against other late-fee settings at the same property.** He
  proposed it, then withdrew it in the same breath: *"actually, no, let's not
  show that table at all. They don't need to know. Because if other late fees
  are less, then that's just going to create them haggling with the landlord,
  and the landlord doesn't want that."* So: their own lease, their own property,
  their own price. Nothing about what anybody else pays.

## What the resident IS shown

Their own figures, computed from their own lease and their own property's
resolved late-fee policy (lease override -> `property_unit_type_late_fees` ->
property, `services/lateFeePolicy.ts`):

- What their lease says about late fees, and that whether it gets charged has
  in practice depended on the landlord.
- What they **could have been charged** across their own history on GAM, with
  waived and credited fees added back — *"what they could have been charged",*
  not what they happened to be charged.
- What FlexPay **would have cost** over the same history.
- The total difference, shown just as plainly when it is negative. The enroll
  path stays open either way, because *"they can do it out of spite for the
  landlord so the landlord doesn't get any late fees if they wanted to."*
- A past-performance disclaimer, *"kind of like what they have in the stock
  market"* — a landlord can change the late fee at lease re-up.

## The bracket cusp — RECOMMENDATION, needs his yes

His worry: a $1,499 rent pays $26 on the 3rd Wednesday and a $1,500 rent pays
$33. With utilities billed back on some units, a resident can cross that line
month to month. *"I don't want people to be feeling like they're getting jerked
around. I want them to have a certain, like, yes, this is what I'm paying."*

**Recommended: the bracket is set by the LEASE RENT, and is fixed for the term.**

- The lease rent is the one number that does not move month to month. Utilities
  riding the bill never change the price.
- It is explainable in one sentence: *your price is set by your rent.*
- Inside a lease term the price may only ever go **down** (a rent reduction),
  never up. A rent increase re-prices at the renewal, told in advance.
- GAM's float is the whole bill including utilities, so a utility swing is
  unpriced exposure — but the brackets run 1.3-3.4% of rent with a $5 step, so
  a few hundred dollars of utilities is small against that, and certainty is
  worth more than the margin.

**Not recommended: showing both possible brackets.** That is the "price is
always changing" feeling, just stated up front instead of discovered.

**Not recommended: rounding up at the cusp.** Someone $1 under a threshold
paying the bracket above is the same grievance in a different costume.

## Where it lives

Tenant portal only. Never the landlord portal, never the marketing site, and
the counterfactual is never a landlord-facing report.
