---
scope: landlord
title: Matching cash and check deposits to rent
---
If your tenants pay you in cash, by check or by money order, that money never moves through GAM — so a tenant's balance stays open until the payment is recorded. GAM can do most of that for you off your linked bank feed, which matters most if you run the property remotely and never see the envelope.

## How a deposit gets matched

When a tenant deposits rent into your bank account, the deposit shows up in your bank feed. GAM looks at what each of your tenants owes and shows you the likely payers on the **Bank** page, with the reason for each: the amount ties out exactly, the deposit names them, or the tenant reported it themselves.

You confirm who it was, and GAM records the payment, applies it to their charges, and — this is the part worth having — **dates it to when the deposit was actually made**, not when you got round to entering it. Any late fee that accrued while the money was in transit comes back off automatically. A fee the tenant already paid comes back as a credit rather than disappearing.

A deposit pays the tenant's **oldest** charges first: rent, utilities, fees, late fees and home payments, with any old balance carried over from before GAM paid last. When a deposit is smaller than what they owe, the match says so ("covers $X of $Y owed") before you confirm, and what it does not cover stays owed. A deposit is new money, so a match never spends the tenant's account credit; if the deposit is more than they owe, the extra is kept on their account as money paid ahead.

If the deposit was not rent at all, use **Not a rent payment** and it goes back to the ordinary categorize flow as other income.

## Why it asks instead of just deciding

Where every unit pays a different amount, the figures usually identify the payer on their own. Where rents are identical — a park where every lot is the same — an amount tells you nothing, and GAM will say so rather than pick one. That is deliberate: recording a payment against the wrong tenant puts one person's money on another's ledger and then onto their credit record, and it is far harder to unpick than choosing from a shortlist.

There are two cases GAM settles without asking:

- **The tenant reported it.** The tenant reported the deposit themselves, the bank confirms it, **and** it adds up exactly to charges they owe. That is independent facts agreeing, none of them a guess, so it needs nobody in the loop. A report never settles more than the deposit: a $300 deposit against a $700 balance pays $300 of charges, oldest first, or goes to you to decide.
- **Nobody reported it, but it is exactly one tenant's whole bill.** A deposit equal to the cent to everything one tenant owes you, all of it billed before the deposit was made, settles that bill when nothing else could explain it: no tenant has a report of that amount waiting, no other deposit of the same amount came in within a few days, and no deposit slip or combination of your office's cash adds up to it. It also has to point to that one tenant: a plain deposit that names nobody, where no other tenant owes the same amount, or a check that names exactly that tenant. A payout from a payment company that happens to match is never taken as rent. The tenant and you are both told.

Either way you can undo it: press **Undo this match** on the deposit under **Bank → Bank feed**. Every charge it paid is owed again, any late fee it took off comes back, and the deposit goes back to you to match — GAM never settles that deposit by itself again. If something has changed since (a charge paid another way, a credit it made already used), Undo says what and changes nothing.

## Tenants can report their own deposits

A tenant who banks their own rent can tell GAM straight away with **"I paid at the bank"** in their portal — the amount, the day, and whether it was cash, a check or a money order. Nothing is credited on their say-so: their balance is unchanged until the deposit appears in your feed or you record the payment yourself. While your bank is connected and syncing, a report whose deposit never appears expires after a week, the tenant is told, and repeated reports that never arrive are flagged to you. Without that, nothing matches a report from a bank feed: the tenant is asked to let you know they paid and keep their deposit slip. Check your own bank and record the payment the way you record any cash or check. Recording a cash, check or money order payment on that lease, dated on or after the day they reported and covering at least what they reported, closes their report as recorded by you.

Encourage it. It is the difference between a deposit you have to attribute and one that files itself, and it earns the tenant the date they actually paid rather than the date the bank posted it.

## Did the office bank what it collected?

If you or your staff take rent in person, GAM tracks the other side of the same question: rent marked collected in person that no deposit has ever accounted for. If the office took in $3,000 and banked $2,750, the $250 gap is listed with the tenants it belongs to.

Treat it as a prompt, not a finding. Cash sits in a drawer over a weekend, and one deposit often covers two days of collection — there is a few days' grace before anything is listed, and you can widen it. What it gives you, which nothing did before, is a standing check that what was collected is what reached the bank.

## What recording a payment costs

Recording an off-platform payment is **free** — GAM charges neither you nor the tenant for it.

This applies to any payment handed over instead of made in the app: cash, a personal, cashier's or certified check, a money order, or a bank draft.

## If you have not linked a bank

None of this works without the bank feed — GAM cannot see a deposit it has no read access to. Linking your operating bank is a separate permission from the payout account you set up with Stripe: that one tells GAM where to send money, this one lets GAM read the transaction history. Both can be the same account.
