# SESSION 653 HANDOFF — written 2026-09-30 (last business day of September)

**READ THIS FIRST, THEN READ THE CODE.** This file is a map, not the territory. Every
claim below about how something works was true when written, but handoffs drift and
have been wrong before. Before acting on any statement here, open the file it points
at and confirm. If the code disagrees with this document, the code is right.

Previous handoff: `SESSION_652_HANDOFF.md` (very long; deploys 69–93 of that session
are appended at its end and are the recent history).

## State of production at handoff

- Deploy 92 is live (all portals in sync). Deploy 93b was running when this was
  written: it carries the pay-link **Adjust** editor (`PATCH /pos/pay-links/:id`),
  cashier-cart adjustments when settling a pay link at the register, Tenants-page
  invites drafting the lease at invite, and the agent-guard declaration for the new
  route. **Check `git log -1` and `launchctl print gui/$UID/com.gam.api` — if 93b did
  not finish, `bash ~/gam/deploy.sh` from a clean tree.** Deploy 93 (first attempt)
  failed only on the actionGap guard; fixed in 93b.
- `gam` is production. Tests only with `DB_NAME=gam_test`. Demo DB `gam_demo` is
  migrated to `20260929150000` (it must be migrated separately — see memory).
- October 1 invoices generate at 7am Phoenix on 2026-10-01. Mountain View's
  September reading round is completed: 26 electric bills + the Alvarados' RV 33
  bill (650 kWh, $136.50) + Dakota Lane's corrected RV 18 bill (481 kWh, $101.01)
  all `billed`, riding those invoices.

## What was decided / built this session (2026-09-29 → 09-30)

Verify each in code; file names are where to look.

1. **Utilities table** (`routes/utility.ts /recovery`): paid / covered by work trade /
   still owed; pay-link and register utility lines count as billed back. Propane at
   the pump excluded.
2. **Propane delivery** (`routes/propane.ts`, `UtilityMetersPage.tsx`): gallons only at
   the property's set rate; supplier invoice optional (margin only).
3. **Mountain View RV 54–73** exist (out of order, "New site — being built out"),
   back-in, 30 & 50 amp, $589/$269/$49, deposit $200, electric submeters with
   baseline 0 dated 2026-09-30. Nic: read EVERY meter every round — never exclude
   out-of-order sites.
4. **Out-of-order history** (`services/outOfOrder.ts`, master schedule
   `outOfOrderHistory`, Reports → By Property "Site downtime"). Button flips to
   "put back in service".
5. **Master schedule**: site column sits BESIDE the timeline (two boxes), not
   sticky over it (`SchedulePage.tsx`, `vScrollRef` / `scrollContainerRef`).
   Memory: gam-schedule-column-beside-not-over.
6. **Tenant-date billing** (`jobs/tenantDateBilling.test.ts` is the rehearsal):
   invite asks an existing resident's own due day
   (`pending_tenant_intents.rent_due_day`); morning notice
   `promptTenantDateMeterReads`; invoice hold uses rounds BEFORE the invoice month;
   own-day residents' first bill = first occurrence of their day on/after the day
   the property was added (`existingTenancyFirstDue`, anchor
   `properties.onboarding_started_at`), NOT floored by first_billing_cycle; the 1st
   keeps S631.
7. **Meter reading list**: "Fix" reopens a line saved this sitting. The **blind
   verification walk is gone** — a flagged read waits in "Readings to double-check"
   (one window); the last one settled completes the run (`finishReadingPhase`,
   `settleFlaggedOnRun`). `utility_reading_double_checks` is history only.
8. **A space move bills the old space** (`services/unitMove.ts` → `billMoveOutRead`
   on the closing read, before the lease changes unit).
9. **Pay links = open tickets**: `GET /pos/tickets` lists open one-time links
   (`kind: 'pay_link'`); `POST /pos/transactions` with `payLinkId` settles one at
   the register (cart as the cashier left it; empty cart = link as sent); link
   marked paid inside the sale. Open tickets and links on `/balances` → Front Desk
   and outstanding list. `PATCH /pos/pay-links/:id` adjusts an open link (deploy 93b).
   A PAID link is fixed: shortfall = new charge, surplus = credit.
10. **Front Desk**: Tenants-page unit invites now write the unit-bound
    `pending_tenant_intents` row (returning residents were invisible). Invoice
    notices skip settled/void invoices.
11. **Data corrections at Mountain View (September)**: Razo = RV 27 (pay link
    $752.17 = site $589 + Aug 387 kWh + Sept 390 kWh; he leaves after Oct 1 — add
    the extra days + a final RV 27 read to the link, then settle Friday); Scott Duffy
    RV 30 = open register ticket $22.47; RV 37 read marked `billed_off_platform`;
    RV 05/16 ignored; Alvarados corrected onto RV 33 from 2026-09-16 (RV 34 vacant,
    its 2 kWh Sept bill voided); RV 43's Sept 30 read corrected 18462 → 18234 (typo;
    meter unchanged since August). Donald Hamp: check recorded 9/29, lease active,
    signature outstanding, now on the Front Desk. Dakota Lane is a man (he/him).
12. **Email**: support@ is a Cloudflare forward to nic@golddoor.io. Replies go out as
    nic@ until Nic's partner enables "Allow per-user outbound gateways" in the
    golddoor.io Workspace admin; then Gmail "Send mail as" over Resend SMTP
    (smtp.resend.com:587, user `resend`, a NEW Resend key). Free route chosen.
13. **Card reader** (Mountain View, order 0001): shipped, arriving Oct 7–8. Nic enters
    the tracking link and Shipped on Admin → Reader Orders; serial when it arrives.

## NEXT — what Nic asked for, in his words (verbatim, 2026-09-30)

> When you say build the, they're leaving on, on the lease with a date, I don't want
> it physically on the document. Nobody's going to know when they sign the document
> when they're leaving. That's the whole problem. They're going to come in and say,
> hey, I'm pulling out Saturday with like maybe three or four days notice, if that. We
> need the front desk to be able to mark it as, hey, they're leaving then. When we get
> the final meter read, we can um, initiate uh, the final bill cycle. far as a
> preferred spot on a wait list, um, that's yeah. So it's some people want it, some
> people don't. Some people don't care as long as they get a spot in the park, and
> they'll figure it out later. And other people will take the 30 and want to be on a
> wait list for a 50. So I don't know. While we're in the middle of upgrading, I don't
> know if that's worth doing because when we mark 50s as available after the first
> section is done, we have to empty out the next section of the park that we're going
> to work on, regardless of who wants the 50 or not. Because we have to dig up a whole
> row at a time. So I I would argue that a preferred spot on a wait list is not as
> important as just the wait list itself. Um, uh, let's see. When a vacating date is
> recorded, the first waitlister whose date fits gets the claim. Only once the
> resident has actually checked out. Never off the intention alone. Yes, that is good
> for the waitlist, but it needs to be not for preferred spot because we like just
> because a spot opens up we may be moving people internally like somebody internal
> is going to get first priority to move versus just bringing somebody in from the
> outside i don't know it's different people may operate differently but i always try
> to not leave people stuck in the least ideal spots and bring new people into the
> better spots. Um, just my philosophy to keep my existing people happy. Um, yeah,
> let's build a thing where we can avoid spots. Um, start building it all when the
> deploy is done. We may need to write a session handoff for context. We're at 94%, so
> let's maybe do that so we can clear. Put my whole notes here in a in the handoff as
> well. And then make sure we only trust the code, never whatever the handoff says,
> because the handoff's usually like to make up one or two things that aren't real.

And from the same conversation, earlier:

> Okay, I thought we had the meter reads set up where they could be edited in the
> field. [built: Fix]
> ...
> I want the system to draft a lease automatically if they just randomly extend...
> People are so fucking indecisive with RV spaces. So maybe we won't do that. Maybe it
> won't be automatic. I'll just invite them if that flow happens. [decision: NOT
> automatic; invite from the Tenants page]
> ...
> How far out does the calendar block it? [answer verified in code: a lease with no
> end date blocks the site indefinitely; no reservation can be placed behind it]
> ...
> the customers that aren't here need to for sure not see a space number until the
> morning they get here. [already the rule: `revealTodaysSites` in jobs/scheduler.ts,
> 6:30am local on arrival day; `site_reveal_sent_at` pins the booking]
> ...
> having an avoided spot. I had somebody they want a spot for the week of Thanksgiving,
> but they didn't like the spot they were in last year... if there's a way to have a
> preference, not only on a ideal site, but on a avoidance type situation.

### Build list (in this order)

1. **"They're leaving on…" — a FRONT DESK mark, not on the document.**
   - Where: the Front Desk page and the lease's row on the Leases page. Permission:
     front desk staff (`front_desk.view` / `utility.read_meters`-tier), not just the
     landlord.
   - Data: a vacating date on the lease (NOT a lease term; NOT on any e-sign
     document). Suggest `leases.vacating_on date` + who/when marked. Migration +
     `npm run migrate && npm run db:dump-schema`.
   - Effect: until that date nothing changes. From that date the space is open on
     the master schedule and for reservations (the packer and `findStayConflict`
     must treat the lease as ending on `vacating_on`). On the day: the final meter
     read (the front desk's "Meter reads due" list already handles departures —
     `getReadsDue` in `services/utilityReadingRuns.ts`) → final bill cycle:
     rent through that day + last electric → `generateFinalUtilityInvoice` /
     deposit return. Check how `lease_units_in_window`, the master schedule query
     (`routes/units.ts /schedule/master`), and `scheduleCompression.ts` read lease
     end dates — they must all honor `vacating_on` as the end.
   - No 30-day notice enforcement. It records what the resident said.
2. **Avoided sites on a reservation.** Alongside the existing requirements
   (`required_site_layout`, `required_amp_service`, `locked_to_unit`) add a list of
   units the guest must NOT be placed on. Honor it in `scheduleCompression.ts`
   (`rankUnitsBestFit` and the relocation path), in the staff booking form
   (`SchedulePage.tsx` new-reservation modal) and the booking site if it lets a
   guest pick. Show it on the reservation detail.
3. **Waitlist — simple, property-level, dates only.** The existing waitlist
   (`unit_booking_waitlists`, `services/propertyBooking.ts`) is per-site with a
   1-hour claim on cancellation. Nic wants: a park-level list ("a spot, any spot,
   for these dates"); when a space actually frees up (a resident CHECKED OUT — never
   on the vacating intention), the landlord/desk is prompted and decides: move an
   existing resident into the better spot first, or offer the vacated spot to the
   first waitlister whose dates fit. Do NOT auto-claim by kind of space; do NOT build
   a preferred-spot waitlist (the park is being dug up a row at a time). Design
   the prompt-and-choose flow and confirm it with Nic before building the auto
   offer.

### Standing rules that bit this session (all in memory too)
- Utilities bill in ARREARS: September usage goes on October 1. Never suggest waiting.
- Ask before building a new mechanism; design choices and money are Nic's calls.
- Fix what you find; never over-claim; verify in the deployed build; a cosmetic bug
  you cannot reproduce gets a structural fix, not a "probably".
- Never repeat "waiting on you" items at the end of every batch.
- Talk plain; Nic is not a coder. American spelling.
- Every deploy: `bash ~/gam/deploy.sh` (full suite, ~8 min), then commit + push +
  append to the handoff. Don't edit code while a deploy is building.

## Deploy 94 (2026-09-30, ~1:15pm) — Oak Park water masters + RV 24 submeter

- Nic's emergency: the Main master (bill_amount, has submetered units under it)
  silently refused to save with only a bill total, and the reopened list showed
  a 5-minute-old cached copy ("28/29" vs "27/29"). `MeterWalk.tsx`: a
  bill_amount master takes the bill total only (usage optional); the list
  refetches after every save (staleTime 0, refetchOnMount always); a line that
  cannot save now says why under the line. September run at Oak Park is
  completed (Main $94.01 → 13 units, Back Row $58 → 4 units).
- RV 24 water submeter created (meter 70983c7e…), RV 24 removed from the Back
  Row master. Baseline read still to be entered by Nic on the meters page.
  September's Back Row split still carries RV 24 at $14.50 — Nic's call
  whether to redo as a 3-way split before the Oct 1 invoices.
- Migration `20260930170000_lease_move_out_notice.sql` committed (columns for
  the "they're leaving on…" front-desk mark; code not built yet).

## Deploys 95–97 (2026-09-30 afternoon)

- **95** — "They're leaving on…" (`services/moveOutNotice.ts`; `POST/DELETE
  /leases/:id/leaving`; `GET /leases/desk/residents`; Front Desk → Move-outs tab;
  Leases page Change menu + "Leaving Oct 3" badge; `components/LeavingModal.tsx`;
  permission `front_desk.mark_leaving`). Register history tells `pay_link` /
  `card_reader` / `card_on_file` apart (`pos_transactions.paid_online`, migration
  `20260930190000`); a history row opens to its lines. Fee ESTIMATE
  (`services/platformFee.ts`) now counts owner-use spaces (the accrual already
  did). MH 03 at Mountain View bills from October (dry run: MV 43, Oak Park 24).
- **96** — Admin "Recurring Revenue" card = platform fees only ($130); the
  processing spread is no longer tagged recurring.
- **97** — Approving a screening drafts its lease in the same click
  (`draftLeaseForApprovedCheck` in `routes/background.ts`; `/decision` returns
  `lease | needsUnit`); walk-ups are asked which space. Admin income: the
  processing true-up files under Processing (`SLICE_TYPE_SQL`); the −$50 of
  Sept 25 "phantom_minimum_reversal" rows were a DOUBLE reversal (S650 had
  already reversed them on Aug 1) — corrected with one +$50 ledger row
  (`double_reversal_correction`).
- Country Acres: still inside onboarding grace (`billing_grace_until`
  2026-10-01, 12 active leases) — the Oct 1 sweep stamps it live and October bills
  its 12 spaces.
- RV 24 water (Oak Park): Nic will fix September's $14.50 RUBS share after he
  gets the original submeter readings.
- Next: avoided sites on reservations (build list #2), then the waitlist design.

## Deploys 98–100 (2026-09-30, late afternoon)

- **98** — Avoided sites on reservations (`unit_bookings.avoided_unit_ids`,
  migration `20260930203000`; packer/relocation/create/edit guards; counter
  form "Sites to avoid", detail "Avoids").
- **99** — Approval = the signing packet (`services/householdPacketDraft.ts`,
  used by `routes/background.ts` `/decision` + `/draft-lease` and by the
  marketplace `properties/applications/:id/onboard`). The bare-lease drafter
  and the LeaseFormModal edit window are GONE; `?open=` shows the read-only
  details, which carries "Confirm — looks right" for needs-review imports.
  Month-to-month drafts write `end_date='-'`. Demo/internal accounts never
  reach `platform_revenue_ledger`. Robert Housley (RV 14, Mountain View)
  signed by Nic: $589/mo MTM from 9/30, page 8 first month $539 / proration
  $0 / deposit $0 — INV-2026-00045 $539 due 9/30, Oct 1 rent skipped
  (paid at move-in), $589 from Nov 1.
- **100** — (a) Screening lists: landlord page = Needs attention / Past
  (`bucket` + `housed` from `GET /background`); admin **Screenings** database
  (`GET /admin/screenings`, super-admin). (b) Money-box tags: template field
  `money_kind` fee/deposit/prepaid (editor "This money is"); `lease_fees.money_kind`;
  deposit boxes billed `type='deposit'` (held, returned by depositReturn —
  `otherHeld`), prepaid boxes `revenue_owner='held'` and a payments TRIGGER
  (`trg_prepaid_fee_follows_payment`) banks them as `lease_prepaid_credits` on
  settlement; invoice/receipt use the box's printed label. (c) Monthly draw:
  `leases.prepaid_monthly_draw` + `lease_prepaid_credit_draws`; cap read by
  `prepaidDrawAvailable` in the invoice run, Pay Now (which now also SPENDS
  prepaid after cash — that was a gap) and the desk (held share via
  `held_payout_items` 'prepaid_draw'); `PATCH /leases/:id/prepaid-draw`;
  Leases page "Credit draw per month…"; tenant Payments card says it.
  (d) Owner-use occupant name/phone/email on units (details PATCH), on the
  desk emergency roster. (e) Bill emails headline the real amount (open lines
  − prepaid draw − account credit; covered lines struck through).
- Ledger cleanup (data, not code): the August phantom $10 minimums, their two
  reversals and the +$50 "correction" were all DELETED (Nic: demo money must
  not exist), the fake August accrual for pool-intake removed, running
  balance recomputed. Books: Aug $9.01, Sep $130 + $74.19 + $10.
- Memory: `feedback-batch-deploys-on-nics-word` — no deploy per change; ship
  when Nic says.
- NEXT: waitlist design (build list #3) — awaiting Nic's answer on the
  prompt-and-choose shape; RV 24 Oak Park September water share once Nic has
  the original submeter readings; Razo's link Friday (extra days + final RV 27
  read).

## End of day 2026-09-30 — undeployed work + Country Acres September water

**UNDEPLOYED (commit f7952e0 and earlier on main, pushed):**
- Screenings good for a YEAR: `SCREENING_VALID_MONTHS = 12` in shared — the
  three `expires_at` stamps (`routes/background.ts` ×2, `services/backgroundApplyUpdate.ts`)
  and the 3 AM expiry sweep. The six months was GAM's own freshness rule from
  June (commit 7c37ffb), never Checkr's or legal. Live rows already extended:
  Anastacio Erreguin → 2027-09-10, Robert Housley → 2027-09-30.
- "Not moving in for now" on an approved applicant: `background_checks.parked_at
  / parked_note` (migration `20260930240000`), `POST /background/:id/park` +
  `/unpark` (declared in actionGap), review-window buttons, Past-tab tag.
  Parked = still approved, off Needs attention; "They're back" reverses it.
  → ship with `bash ~/gam/deploy.sh` when Nic says.

**Country Acres (Mattoon) September water — DONE in prod (data, no code):**
- Meters re-set to what the readers see: digits 5 / multiplier 100 (Lot 17:
  digits 6 / multiplier 10) = 10^(7 − face digits) gallons per unit; the
  July/Aug placeholder reads converted to face integers (same math). Nic:
  "August numbers are the baseline" — NOT deleted.
- Reads entered in run d92343a2… (Lots 1,6,11,15,17,21,22,24,28,29,30; Lot 8
  at its base value = 0 usage; Lot 18 = a BASELINE read 9442 dated 9/30, no
  bill — its prior value was a placeholder). Run completed: 9 bills, $862.95
  at $0.0165/gal. Big ones to eyeball: Lot 17 19,800 gal ($326.70), Lot 21
  10,000 gal ($165.00).
- Oct 1 dry run for the landlord: 11 invoices, 8 utility lines; Mike Boyd
  (MH 15) already had INV-2026-00016 from his 9/25 signing, so his $18.15 was
  attached by hand (`attachStrandedUtilityBill`) → $468.15. All 9 water bills
  land on Oct 1.
- Landlord `billing_grace_until` 2026-10-01: the Oct 1 sweep stamps them live
  and October's platform fee bills their 12 spaces.

**Still open:** waitlist design (build list #3; prompt-and-choose shape
proposed, awaiting Nic); RV 24 Oak Park September water share (Nic will bring
the original submeter readings); Razo Friday (add days + final RV 27 read to
his link before settling); MH 03 occupant details (Nic enters on the unit
page once deploy 101 ships… the occupant fields are LIVE already in 100).
