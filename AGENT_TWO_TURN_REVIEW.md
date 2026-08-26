# Two-turn agent review — Nic's verdicts (2026-08-25)

Recovered from the published artifact after the session that produced it was
cleared. THIS FILE IS THE RECORD — the artifact is a rendering of it, not the
other way round.

**5/19 actually clean · 3/13 launch-critical clean · 11 need work · 6 I scored wrong**

The last figure is the important one: six conversations were originally graded as
passing and do not pass. The automated eval (agentEval.ts) grades tool selection,
escalation and forbidden phrases — none of which catch "the words are true and
the customer walks away with the wrong idea". That is the bar these notes hold.

## Tenant · Ava — 1/6 (launch-critical)

### balance then pay half — **fails**
*told what they owe, asks to split it — the single most natural reaction to a big number*
- tools on turn two: `get_my_payment_status`  · **repeated the first reply**
- **Nic:** Should volunteer the platform-wide rule, unprompted.
- **Fix:** When giving a balance, state that GAM has no split payments at all — platform-wide, not a property setting. Say it again plainly when asked to pay half. Drop the oldest-first mechanics; they only matter if partials were possible.

### late fee then waive — **fails**
*hears the late fee, immediately asks for it to be waived — pushing on a money hard stop*
- tools on turn two: `get_my_lease`  · **repeated the first reply**
- **Nic:** Right facts, robotic delivery, and it omits the argument that actually answers them.
- **Fix:** Read human: 'looks like your lease has a $15 late fee, charged once when rent goes late.' Then do the math out loud — the grace period already gave them 5 days, so they're not 2 days late, they're 7. Close with the frame, not a lecture: not arguing, that's what's in the lease, and the platform runs on the lease. Some of this belongs in the first reply, the grace-period math only once they ask for a waiver.

### lease end then renewal — **fails**
*SEGUE — gets the lease end date, naturally asks what happens next*
- tools on turn two: `none`
- **Nic:** Should infer 'renewal' from the two messages together. Never promise a rate.
- **Fix:** Infer renewal from turn 1 + turn 2. Don't quote a number and don't characterise the increase — no '5-10% more'; a landlord would not appreciate it. Tendency only: 'your landlord usually renews' / 'usually doesn't'. Then hand it over: GAM handles platform questions, but the lease is a legal document between them and the landlord, so that one is worth asking the landlord directly.

### maintenance then accept — **partly right**
*ACCEPTS the offer the agent made — the commonest two-turn shape there is*
- tools on turn two: `file_maintenance_request`  · **repeated the first reply**
- **Nic:** The tenant follow-up is unrealistic — the agent had already said it filed it. That one is on the test, not the agent. But the re-file is real.
- **Fix:** When someone confirms something already done, acknowledge and add the useful next fact — 'yep, good to go, maintenance usually gets back within 24-48 hours' — and do NOT file a second request. The duplicate row is the actual defect.

### deposit then correction — **passes**
*CORRECTS the agent — thinks the number is wrong and asks it to check the document*
- tools on turn two: `get_my_full_lease`
- **Nic:** No issues raised.

### balance then decline — **fails**
*DECLINES the offer — the agent must let it go, not keep selling*
- tools on turn two: `get_my_payment_status`  · **repeated the first reply**
- **Nic:** The FIRST reply was already wrong, before the repeat.
- **Fix:** Give the breakdown and stop. Cut 'payments always apply to the oldest open charge first' and everything after it — rent is due in full, so there is no partial to allocate. And 'unapplied remainder becomes pay-ahead credit' is FABRICATED: how-payments-are-applied.md says you cannot pay a partial amount or pay ahead, and a payment that isn't the full balance is declined.


## Landlord · David — 1/5 (launch-critical)

### narrow then answer — **fails**
*THE case for Nic's rule — agent asks which Chen, landlord says which, and must now ANSWER*
- tools on turn two: `lookup_tenant_payment_status`
- **Nic:** Not a pass. The landlord should never have had to narrow this.
- **Fix:** 'what's chen's balance' was parsed literally — it searched for a tenant named 'what's Chen'. The question word gives away that no human is reading it. Strip interrogatives before matching a name: a person sees Chen's, possessive, and searches Chen.

### vacancy then drill down — **fails**
*gets the portfolio number, drills into one property — the normal way a landlord narrows*
- tools on turn two: `get_vacant_units`
- **Nic:** Not a pass. If it can list 13 across the portfolio, it can filter to one property.
- **Fix:** The drill-down must actually filter. Answering the portfolio question and then failing the narrower one is backwards — the narrower query is the easier one.

### delinquent then notice — **fails**
*sees who is behind and asks for the obvious action on one of them*
- tools on turn two: `draft_tenant_notice`
- **Nic:** Second message reads well, but the list itself is wrong — flagged the $2 test payment as outstanding.
- **Fix:** NOT an agent bug, and not stale data. Stripe reports the PaymentIntent as still processing with amount_received 0, fourteen days on, live mode, ACH. The DB matches Stripe exactly. The money never arrived, so the delinquency is correct. What needs looking at is the stuck ACH itself — and note the intent is $8.00 covering a remittance, not $2.

### pl then expenses — **passes**
*SEGUE — gets a P&L that says no expenses are recorded, asks how to fix that*
- tools on turn two: `none`
- **Nic:** Good — walks them through getting expenses in.

### expirations then one unit — **partly right**
*SEGUE — from what is expiring to the specifics of one of them*
- tools on turn two: `get_unit_lease`
- **Nic:** Reads fine, but it stops short of being useful.
- **Fix:** On the FIRST reply, when naming a tenant and unit with a lease ending soon, offer the direction: do they want to find out if the tenant is renewing, or is someone else lined up for the unit? Renew with a bump, non-renew and re-rent — ask which way they're leaning.


## Marketing · Lucy — 1/2 (launch-critical)

### pricing then scale — **fails**
*hears the price and volunteers their portfolio — the qualifying moment*
- tools on turn two: `none`
- **Nic:** Tone problem. 'The real number depends on your setup' reads like it might go UP.
- **Fix:** Frame it as a floor with room to come down: starts at $2 per occupied unit per month, and there are ways to bring that number down depending on what they're running. Never imply the price grows with their setup.

### call then pick time — **passes**
*THE booking case — asks for a call, then picks when*
- tools on turn two: `none`
- **Nic:** Asked whether the offered time was real. It is.
- **Fix:** Verified: listAvailableSlots reads real windows from sales_call_availability, excludes booked slots, and honours minimum notice and a booking horizon. Nothing invented.


## Guest · Skye — 1/3 (later)

### late checkout commit — **passes**
*THE confirm-then-act case — gives the specifics, so the request must actually be sent*
- tools on turn two: `request_booking_change`
- **Nic:** No issues raised.

### amenity then book — **fails**
*hears an amenity exists and asks to reserve it — accepting with specifics*
- tools on turn two: `get_guest_amenities`
- **Nic:** Jumps straight into the deep end — pun intended.
- **Fix:** 'Is there a pool?' should answer the question: yes, plus hours and anything the landlord has set (heated, etc). Do NOT assert that reservations need host approval unless the pool is actually reservable, and don't push a time slot. It also hasn't established they have a reservation.

### stay then extend — **partly right**
*SEGUE — checks their dates, then decides they want longer*
- tools on turn two: `request_booking_change`
- **Nic:** Extends correctly now, but leaves out the thing they'd ask next.
- **Fix:** Confirm the nightly rate when offering the extension. It can already read the booking, so it can read the property's rates — quote them rather than making the guest ask.


## Booking site · Skye — 1/3 (later)

### rates then dates — **fails**
*gets the rate card and supplies real dates — the quote must become a real total*
- tools on turn two: `check_availability`
- **Nic:** Three separate problems.
- **Fix:** 1) '$48 per night' runs straight into 'Remember' with no space — the run-on formatting bug, still present. 2) Give the WEEKLY rate as an upsell with the actual number; saying 'better rates for weekly and monthly' without the figures wastes the pitch. RV people expect longer stays to be cheaper. 3) It replied 'I apologize for the confusion, it seems I used the current date' — wrong instinct. It should ASK WHICH MONTH. We're past 15 August, but they may mean September. Never assume a bare day number is in the past.

### quote then book — **fails**
*says yes to booking — must confirm details or collect what it needs, never book silently*
- tools on turn two: `none`  · **repeated the first reply**
- **Nic:** Same date bug, and my follow-up was unrealistic.
- **Fix:** Same fix as above: confirm the month rather than assuming the customer meant a date that already passed. Separately, 'yeah let's go ahead and book that' is not something a real customer would say when they were given no real information — that bad follow-up is what triggered the repeat. Rewrite the case.

### rates then monthly — **passes**
*SEGUE — nightly rates prompt the longer-stay question*
- tools on turn two: `get_property_pricing`
- **Nic:** Looked good.
