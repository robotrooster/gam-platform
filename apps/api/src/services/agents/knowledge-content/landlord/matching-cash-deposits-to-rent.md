---
scope: landlord
title: Matching cash and check deposits to rent
---
If your tenants pay you in cash, by check or by money order, that money never moves through GAM — so a tenant's balance stays open until the payment is recorded. GAM can do most of that for you off your linked bank feed, which matters most if you run the property remotely and never see the envelope.

## How a deposit gets matched

When a tenant deposits rent into your bank account, the deposit shows up in your bank feed. GAM looks at what each of your tenants owes and shows you the likely payers on the **Bank** page, with the reason for each: the amount ties out exactly, the deposit names them, or the tenant reported it themselves.

You confirm who it was, and GAM records the payment, applies it to their charges, and — this is the part worth having — **dates it to when the deposit was actually made**, not when you got around to entering it. **The bank's date decides.** A late fee that was charged after the money was already in the bank was never owed, so it **comes off**: it drops to $0.00, with the bank's date noted on it. A fee the tenant already paid comes back as a credit rather than disappearing. The payment counts from the day the bank shows — **on time if it was on time**. A late fee charged before that day stands, and then the payment counts as late.

A deposit pays the tenant's **oldest** charges first: rent, utilities, fees, late fees and home payments, with any old balance carried over from before GAM paid last. When a deposit is smaller than what they owe, the match says so ("covers $X of $Y owed") before you confirm, and what it does not cover stays owed. A deposit is new money, so a match never spends the tenant's account credit; if the deposit is more than they owe, the extra is kept on their account as money paid ahead.

If the deposit was not rent at all, use **Not a rent payment** and it goes back to the ordinary categorize flow as other income.

## Why it asks instead of just deciding

Where every unit pays a different amount, the figures usually identify the payer on their own. Where rents are identical — a park where every lot is the same — an amount tells you nothing, and GAM will say so rather than pick one. That is deliberate: recording a payment against the wrong tenant puts one person's money on another's ledger and then onto their credit record, and it is far harder to unpick than choosing from a shortlist.

There are two cases GAM settles without asking:

- **The tenant reported it.** The tenant reported the deposit themselves, the bank confirms it, **and** it adds up exactly to charges they owe. That is independent facts agreeing, none of them a guess, so it needs nobody in the loop. A report never settles more than the deposit: a $300 deposit against a $700 balance pays $300 of charges, oldest first, or goes to you to decide.
- **Nobody reported it, but it is exactly one tenant's whole bill.** A deposit equal to the cent to everything one tenant owes you, all of it billed before the deposit was made, settles that bill when nothing else could explain it: no tenant has a report of that amount waiting, no other deposit of the same amount came in within a few days, and no deposit slip or combination of your office's cash adds up to it. It also has to point to that one tenant: a plain deposit that names nobody, where no other tenant owes the same amount, or a check that names exactly that tenant. A payout from a payment company that happens to match is never taken as rent. The tenant and you are both told.

Either way you can undo it: press **Undo this match** on the deposit under **Bank → Bank feed**. Every charge it paid is owed again, any late fee it took off is owed again (a credit it gave is withdrawn), and the deposit goes back to you to match — GAM never settles that deposit by itself again. If something has changed since (a charge paid another way, a credit it made already used), Undo says what and changes nothing.

## Deposits you record by hand

You can also record a tenant's bank deposit yourself, from the bank's receipt: **Record payment** (or **Post a payment**) and choose **Bank deposit**, with the day they deposited it and the deposit reference number from the receipt. Until your bank feed shows that deposit, GAM has only your word for the date, so a late fee charged after that day is **credited** — the fee stays on the bill with the credit against it, and the bill nets out — and the payment still counts as a **late payment** on the tenant's payment history, counted from the day it was recorded in GAM.

In the tenant's **onboarding month only**, you can delete a late fee like that outright instead — that month is the one exception, because your bank may not be fully linked to GAM yet: tick **Delete the late fee completely (onboarding month)** when you record the deposit, or press **Delete this late fee** on its line in their payment history. The fee and its credit are removed, and the payment counts from the day the money was deposited, so nothing shows on their record. Only the owner or a property manager can do this, and only in the onboarding month — after that, a late fee is credited, never deleted.

When your bank feed then shows that same deposit, **the bank's date decides after all**. GAM ties the bank's line to the deposit you recorded — by itself when the reference number from the bank's receipt appears on the bank's line, or when yours is the only deposit of that amount and no other deposit of the same amount came in near it; otherwise it waits on the **Bank** page for you to press **This is the deposit I recorded**. No money moves again. A late fee the bank shows was never owed comes off (its credit is withdrawn), and the payment counts from the bank's day, on time if it was on time. If the bank shows the deposit was late, nothing changes: the credit stays and the late payment stands. **Undo this match** puts it back the way you recorded it.

## Tenants who deposit rent at your bank

Each property has a setting, **Tenants may deposit rent directly at the bank**, which is off unless you turn it on. Turn it on where tenants deposit rent at your bank themselves: GAM matches each deposit to their bill using your bank feed. While it is off, tenants there are not offered **"I paid at the bank"**, **Bank deposit** is not offered when you record a payment, and GAM never matches a bank deposit to a tenant's bill there by itself — at a property like that, a deposit at your bank is your office's own cash and checks, which your deposit slips match.

## Tenants can report their own deposits

A tenant who banks their own rent can tell GAM straight away with **"I paid at the bank"** in their portal — the amount, the day, about what time they were at the bank, and whether it was cash, a check or a money order. When two tenants report the same amount, GAM tells their deposits apart by the day each one went in and, when your bank writes the time on its line, by the time that falls in or near the hour each gave — a time that fits neither tenant's hour decides nothing. If both deposits count from the same day either way, GAM pairs them in the order the reports came in. When it can't tell them apart and it matters — two reports and one deposit with nothing to tell them apart, or deposits that went in on different days, so which is whose decides who paid late (the bank's times never decide that one) — GAM doesn't guess: the **Bank** page shows each report's day, time, reference number and photo, and you pick. When one deposit equals what two tenants reported together, GAM can't split one deposit between them: record each tenant's part from the **Payments** page. Nothing is credited on their say-so: their balance is unchanged until the deposit appears in your feed or you record the payment yourself. While your bank is connected and syncing, a report whose deposit never appears expires after a week, the tenant is told, and repeated reports that never arrive are flagged to you. Without that, nothing matches a report from a bank feed: the tenant is asked to let you know they paid and keep their deposit slip. Check your own bank and record the payment the way you record any cash or check. Recording a cash, check or money order payment on that lease, dated on or after the day they reported and covering at least what they reported, closes their report as recorded by you.

Encourage it. It is the difference between a deposit you have to attribute and one that files itself, and it earns the tenant the date they actually paid rather than the date the bank posted it, for their late fees and their payment history: when the bank bears that date out, a late fee charged after it comes off and the payment counts as on time if it was on time.

## Did the office bank what it collected?

If you or your staff take rent in person, GAM tracks the other side of the same question: rent marked collected in person that no deposit has ever accounted for. If the office took in $3,000 and banked $2,750, the $250 gap is listed with the tenants it belongs to.

Treat it as a prompt, not a finding. Cash sits in a drawer over a weekend, and one deposit often covers two days of collection — there is a few days' grace before anything is listed, and you can widen it. What it gives you, which nothing did before, is a standing check that what was collected is what reached the bank.

## What recording a payment costs

Recording an off-platform payment is **free** — GAM charges neither you nor the tenant for it.

This applies to any payment handed over instead of made in the app: cash, a personal, cashier's or certified check, a money order, or a bank draft.

## If you have not linked a bank

None of this works without the bank feed — GAM cannot see a deposit it has no read access to. Linking your operating bank is a separate permission from the payout account you set up with Stripe: that one tells GAM where to send money, this one lets GAM read the transaction history. Both can be the same account.
