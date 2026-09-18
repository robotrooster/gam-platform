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
