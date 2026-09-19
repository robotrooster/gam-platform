# Session 649 Handoff — 2026-09-18

Everything is committed and pushed. The API and the landlord portal are live.
**Not live:** pos.goldassetmanagement.com. A Vercel outage ("Elevated Errors Triggering Deployments") stuck its build. Only the business-register card-fee change is waiting there. Rerun `bash deploy.sh` once Vercel recovers.
- **If Vercel hangs at "Completing…" again:** the deployment is often already Ready. Run `npx vercel inspect <url>`, then `npx vercel promote <url> --yes` from the app's folder.

## Done this session
### Data fixes (prod; backups in ~/gam-backups/s649-*)
- **Randy Olson, Scott Vigne, Jonathan Busby (Oak Park):** September charges settled as `prior_arrangement` (paid to the old software; Nic's direction). Their invoices closed automatically.
- **Randy Olsen → Olson:** fixed on his account, his signer record and two lease boxes. His signing email was re-sent.
- **Ray Artiaga (Mountain View RV 09):** off the platform. Unsigned lease voided (unwound), October invoice void, both invites cancelled, $0.42 held electric written off. His login was kept (Nic).
- **Mountain View register items added:** RV site daily $49 / weekly $250 (both 6.35% lodging tax), monthly $589 (no tax), Electric per kWh $0.21. Categories "Stays" and "Utilities", Mountain View only.

### Code (deployed)
- **Record Payment:** works from ANY open charge (utility, one-off), not just rent. It settles the whole balance. This was blocking Jeremy Parker's $96.81 electric; Nic records that himself.
- **One card fee platform-wide:** businesses pay 3.5% + $0.55 on cards and $6 on bank payments.
- **Long-stay proration:** 30+ night stays prorate partial months by the real days in the month.
- **Short-stay balance:** on arrival day the guest is emailed a pay link for the rest after the deposit (services/stayBalance.ts, runs hourly). Long stays bill through their booking lease, month by month.
- **Out-of-order sites:** unit_out_of_order table plus unit_out_of_order_overlaps(). Used by the compressor, the best-fit ranker, the booking site, staff bookings and the unit picker.
  - The schedule shows these days striped; the ⛔ button on each site row manages it.
  - Stays already on the site are moved off where possible. If not, the landlord is notified.
- **Earlier today (S648 tail):**
  - Refunds on invoices paid in parts go back to the original payment source. Mark-paid adds a payment instead of overwriting.
  - Daily 3:45 check for held charges with nothing recorded, and for payees who owe GAM back.
  - Card-fee payer setting per property (register / booking site).

## Open — ask Nic
1. **Ray's RV 09 meter:** it will keep producing held electric that would be billed to the next RV 09 lease. Nic wants him off-platform, so RV 09 probably needs a "don't bill utilities" setting.
2. **Andres Razo (Mountain View RV 27):** no lease, only an open invite. Nic is billing him by pay link from the register.
   - Offered: write off the $81.27 held electric (8/1–9/2, 387 kWh) on RV 27, and cancel his invite. Waiting on Nic's yes.
3. **Stripe rep:** confirm platform-level fees (payouts, account fees) are billed to GAM, not taken from landlord balances.
4. **BBPOS WisePOS E reader:** Nic orders it; it pairs to GAM's account.

## Still to build
- Register stays → create the booking on the schedule.
- Card option on front-desk Record Payment.
- Signing queue / "something's wrong" button / undelivered-email flag.
- Native apps (Capacitor), then the PM deal.
- Property settings questionnaire (Nic: billing on the 1st vs signing day belongs there).

## Later on 2026-09-18 (all deployed and pushed)
- **Register was empty for Nic's two-company account.** Fixed: the company is now derived from the property.
- **Outstanding Balances shows open emailed pay links** as their own lines, from the moment they're sent until they're paid or closed, with a "Send again" button.
- **Pay-link form has a "Find someone" search.** Your own tenants and customers match on part of a name, email or phone. Anyone else on GAM matches only on their full email or phone.
- **Held utilities release ONLY onto a resident being onboarded** (is_existing_tenancy). When a new tenant signs, held usage is closed out and the landlord is told.
- **Andres Razo** (Mountain View RV 27, moving out): pay link sent and delivered ($670.27). His lease draft is voided, both invites are cancelled, and the $81.27 held electric is written off (it's on his link). A follow-up final electric bill comes after his move-out read.
- **Mountain View register items:** RV daily, weekly and monthly, plus Electric per kWh.

## Nic's to-do list for next session (in his words, as given)
1. **Held electric expires with the onboarding window.** It should only be held DURING the onboarding window, which is shorter now that the lease and invoice are generated as soon as Nic signs the draft.
2. **Per-item POS tax, with named tax kinds.** Tax rates can only be set on a category today, not on an item. Electricity is untaxed, but propane carries sales tax (Arizona's transaction privilege tax — ask whether to label it just "sales tax"), and both sit under Utilities. Short stays need "lodging tax" shown as lodging tax.
3. **Front-counter (staff) register lockdown.** Verify the front-counter person can only ring up sales and email pay links: no inventory, no item setup or edits, no discounts, no settings.
4. **Out-of-order testing.** Nic is going to test marking sites out of order.
5. **Master Schedule order.** RV spots at the top, mobile homes lower (RVs turn over more). Currently alphabetical.
6. **New reservation forms.**
   - The landlord portal's current new-reservation form belongs on the booking site (for guests).
   - The landlord side needs a much simpler, completely different form. **ASK NIC** about it before building.
7. **Dashboard:** remove the small print under Outstanding Balances ("$2,384 more suspended while it is worked off").
8. **Next disbursement ($495) and the Disbursements page.**
   - Clicking the tile gives no details; it just lands on the Disbursements page.
   - That page shows "collected / held for payout / held until your bank is linked / available now / link your bank" as disconnected pieces. It needs to read as one continuous flow and show what the $495 is made of.
9. **Front Desk page:** fine as is (already filtered by property, shows outstanding balances, and shows "sign the lease" / "waiting on cosigner" instead of "accept").
10. **Work trade** (Financials page): everyone on work trade at Mountain View and Oak Park has no hour logging. This needs a REDESIGN later; Nic isn't doing it now.
11. **Screening page:** "ask me about the screening page with the unit selection". **ASK NIC.**
12. **Rent roll mismatch** (Financials, Mountain View). The totals match ($16,294 both ways), but the page says "payable across 32 occupied units" while the fine print says "41 units", plus "9 units on work trade, settled in hours".
    - Those 9 are Nic's snowbirds (seasonal help): no work trade now and no bill now.
    - **Scott Johnson and John Kavasnika** should be HIBERNATED: the lease is asleep and nothing bills, but the space stays occupied and unavailable. Reconcile the counts.
13. **Mattoon, Illinois park** (new landlord onboarding for October rent):
    - Two water meters per house. One bills with an odd multiplier formula and is tracked in cubic feet (per minute?). **DESIGN WITH NIC** before building.
    - The landlord wants to get the meters in quickly and fix them later, so correcting a meter's setup or odometer afterward needs to be EASY. Make that path smooth.
14. **Admin 2FA email.** The code went to the wrong address because the browser autofilled realestaterhoades@gmail.com. The admin login is nic@golddoor.io. Not a server bug; possibly stop autofill on the admin email field.
15. **Landlord signups:** checked. The last new landlord signup was Meryl Rhoades on 2026-09-03, so no alerts were missed.
16. **Admin landlord count: group partnerships.**
    - Nic appears twice. Tyler Rhoades (co-owner only) shows as a separate landlord. Nic and Blu Haws co-own one property, but each also owns properties the other doesn't.
    - Rule: count someone as a standalone landlord only if they bring their own property to the platform. Co-owners of only someone else's properties don't inflate the landlord count. Portal access is unaffected; this is counting only.
17. **Still open from earlier:** Ray Artiaga's RV 09 meter (off-platform), the Stripe rep question, and ordering the card reader.
