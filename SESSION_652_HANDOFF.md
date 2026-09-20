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

---

## Verified against code, not taken on trust

These S651 claims held up: the 08:30 fee-debit sweep with no consent gate, ACH
at $6 flat from the shared schedule, the suppression check on the single send
path, the 04:35 mail sync and 03:50 geocode retry, the renter pool, register
stays, and Country Acres' 47 lots / 13 sent leases / 11 voided contracts.

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
4. **Blu signs the 13 leases.** Invoicing backfills 30 days, so a signature any
   time through about **30 October** still bills October in full. After that,
   October has to be billed by hand.
5. **Country Acres onboarding window expired 9/11** — left alone deliberately.

### Still to do at Mattoon
6. **The 11 installment contracts**, after the leases are signed. The packet now
   works either way, so they can go out with a lease or on their own.
7. **Six adults are occupants, not signers.** If any should be liable co-tenants,
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
