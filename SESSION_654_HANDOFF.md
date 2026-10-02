# Session 654 — 2026-10-01: the October 1 billing run, repaired

Previous handoff: `SESSION_653_HANDOFF.md`.

## What Nic reported

- Work-trade residents (Mountain View, Oak Park) were sent October bills.
- Every Country Acres resident looked wrong; Bowman "$489.60" vs the sheet's $550 base.
- Myria Skinner's screenshot: "$200 outstanding in addition to the invoice."
- Troy Street asking about a missing water bill.

## Causes (all verified against prod data + code)

1. **Monthly run never suspended covered work-trade lines.** Only the move-in
   bill (`jobs/moveInBundle.ts`, S634) wrote a covered line as suspended / out of
   the amount due. `jobs/invoiceGeneration.ts` issued gross (the S624 month-close
   model), so the SECOND bill of every work-trade tenancy read as owed, the
   who-owes page counted it, and the bill email headlined "$460.00 due".
   Nine residents: Scheeler, N. Rhoades, Negrete, B. Valdez, Robinson, Gutierrez,
   Conklin (Mountain View), T. Rhoades (Oak Park), Clabough (Country Acres).
2. **Nobody has ever logged a work-trade hour** (`work_trade_logs` is empty), so
   the Oct 1 month-close credited nothing for September; with
   `carry_forward_months = 1` the Nov 1 close would have billed September back as
   a carried balance and ENDED the agreements.
3. **Rent-to-own installment billed standalone.** `billDueHomeSaleInstallments`
   (4:20 cron) wrote a `home_payment` row with no invoice; the 5:00 invoice run
   had no home-sale code. Invoice, email headline, and who-owes page omitted it;
   the tenant Pay page showed a second box with no lease. Myria's "$200
   outstanding in addition to the invoice" IS this box (I misread the dictation
   as $2,200 and chased a number that never existed — see memory
   `feedback-no-narrated-side-quests`).
4. **Three purchase agreements unsigned by the tenant** (Rueff MH 11 $150, Smith
   MH 18 $100, Whitfield MH 24 $150): Blu signed 9/22, tenants were sent links.
   Nothing bills until they sign. Not a code problem.
5. **Water: zero-movement reads.** Blu entered 9/30 reads equal to July and
   August on lot 22 (2072) and lot 24 (8576) → zero usage → no line. Lot 18 got
   a baseline (9442) → bills next month. Meters likely stuck or not read.
6. Reader bug found on the way: `balances.ts` / `invoiceNotice.ts` openBills
   netted suspended rows against totals that already excluded them (S634
   shape) → RV 50 / RV 51 showed −$589 and Bret's/Ruben's October hid behind
   September. `landlords.ts` dashboard + `reports.ts` subtracted `traded` and
   clamped, which would have shown Curtis (rent traded, water owed) at $0.

## Nic's directives this session

- **"Work trade people are on work trade. There's no bills going out to those
  people. My people at my properties are auto complete work trade until I
  change it back."** Other landlords may track hours (Curtis/Blu does).
- The home payment belongs ON the rent invoice ("$450 + $200 = $650").

## Data repair (prod, committed — `scripts/oct1_billing_repair.ts`, DRY=1 to replay the plan)

- `tracks_hours = false` on all 9 Oak Park / Mountain View agreements (incl. the
  two paused: Johnson RV 50, Kvasnicka RV 51).
- 14 covered October lines suspended across the 9 invoices; 13 invoices rebuilt
  to the S634 total (incl. the four pre-S634 September invoices that still
  carried gross totals: INV-2026-00001/00006/00012/00015). Curtis's October =
  $110.55 water only.
- 15 open settlement periods on Nic's agreements set to 0 hours (the Nov 1
  close settles them as covered). Curtis's pre-created October period linked to
  INV-2026-00027. A September period created for MH 02 (never had one).
- The six standalone October home payments moved onto their invoices:
  Sheptock $757.25, Skinner $815.00, Street $525.00, McCoy $689.60,
  Mitchell $678.05, Bowman $589.60. `invoices.subtotal_home_payments` added
  (migration `20261001100000`).
- Verified: who-owes shows $0 for all nine work-trade residents; Lisa's Pay
  page = $0; Bowman's = one box $589.60 (rent + water + home payment).
- **August electric billed twice at Mountain View** (found by the verification
  pass, confirmed in the data): this morning's run created August-cycle
  electric bills for RV 49 Parker ($96.81), RV 36 Avalos ($81.27), RV 04 Kenyon
  ($93.87) — all three already had August on their September bills, recorded
  as cash — and RV 44 Dakota Lane ($93.87, the previous occupant's usage; his
  lease started 9/2). Cause: August was collected by hand in September as
  payment rows with no `utility_bills` row, so the engine saw August readings
  with no bill and re-billed the cycle as a straggler. Voided all four with
  `scripts/oct1_august_electric_repair.ts` (same mechanics as load17): bills
  void, pending lines removed, invoices reduced — RV 49 $729.70, RV 36
  $557.37, RV 04 $517.47, RV 44 $708.49, and (Nic: look at September) RV 33
  Alvarado $631.50 — his September bill already carried "Electric — Aug 2026"
  $81.27 as cash on 9/18.
- **Tenant Pay page: one button** (`apps/tenant/src/pages/PaymentsPage.tsx`).
  Nic: "They can't choose what they pay. They pay everything that's owed." With
  two or more payable leases the page showed a bare "Pay all" card plus a Pay
  button per lease; Myria read her standalone $200 home-payment box as "a
  previous outstanding balance". Now: one card in the single-lease shape —
  total, what each space contributes, the fee for each way of paying (summed
  per lease, since each lease is still charged separately), a report-deposit
  button per space, ONE Pay. Per-lease cards render only when there is one.
- **Country Acres water, one unit each (Nic, for Blu):** lots 18 Smith, 22
  Street, 24 Whitfield had no water read to bill. Blu wants each billed one
  unit = 1,000 gal = $16.50 at $0.0165/gal. `scripts/oct1_country_acres_water_estimates.ts`
  wrote a September water bill per lot (estimated, no reading rows — meter
  history untouched) onto the October invoice: MH 18 $466.50, MH 22 $541.50,
  MH 24 $466.50. Lots 22/24 stay out of service until Curtis fixes them and
  Blu clicks Mark repaired; the next real read bills real gallons.
- **NOT done: no emails re-sent.** Fourteen residents hold this morning's email
  with a stale headline: the six Country Acres rent-to-own households and the
  three one-unit water lots (too low), Curtis Clabough ($560.55 → $110.55), and
  the five Mountain View August voids (too high). Re-send = reset `sent_at` on those invoices and run
  `sendPendingInvoiceNotices({ invoiceId })` — only on Nic's word. Work-trade
  residents get nothing (directive).
- Pre-existing calendar flakes fixed so the deploy gate passes on the 1st:
  `portalLockSweep.test.ts` (older bills now anchored to the latest bill, not
  NOW()) and two `utilityBilling.test.ts` move-out reads (prior read dated
  yesterday, not the cycle's 1st). `workTradeCredit.test.ts` and
  `workTradeNotRevenue.test.ts` updated from the gross-bill model to the
  suspended one.

## Code (deploy 101)

- `jobs/invoiceGeneration.ts`: covered lines suspended at generation (same
  `covered_charges` reading as the move-in bill); `total_amount` = what is owed;
  home-sale installments due this cycle ride the invoice as `home_payment` rows,
  never work-trade creditable; `reconcileHomeSaleContract` after commit.
- `services/homeSale.ts`: the 4:20 job skips a buyer with an active lease on the
  unit (the invoice carries it); still bills a buyer with no lease.
- `services/invoiceNotice.ts`: a work-trade invoice with nothing owed sends NO
  email and is stamped sent (`skippedCovered`); openBills no longer nets
  suspended rows.
- `routes/balances.ts`, `routes/landlords.ts`, `routes/reports.ts`: suspended
  lines are outside `total_amount` everywhere now; not subtracted again.
- Tests: `jobs/workTradeMonthlyRun.test.ts` (new, 6), `services/invoiceNotice.test.ts`
  (+2), `routes/balances.test.ts` (+2), `routes/homeSale.test.ts` fixture
  (`occupies:false` for the standalone path).

## Afternoon (Nic back)

- **Updated-bill emails SENT** to the fourteen residents whose October bill
  changed (`scripts/oct1_resend_updated_bills.ts`): subject "Updated bill: $X
  due…", a line saying it replaces the morning's email. `emailInvoiceReady`
  takes `updated`; `sendPendingInvoiceNotices({ invoiceId, updated: true })`.
- **Disbursements: check money was headed to Nic's bank.** The prepaid-credit
  release (S609) booked an `allocation_owner_share` for every row it settled,
  including credits funded by CHECKS the landlord already has: Greek $460 (check
  remittance), Niemeier $460, Renspurger $14.70, Rader $5.22 (landlord-entered
  credits). Tuesday's batch would have paid Nic a second time out of GAM's
  Stripe balance. `services/prepaidRelease.ts` now releases only dollars GAM
  holds (remittance ach/card with a Stripe intent, or a platform-held source
  payment); a check/landlord credit settles the row like recorded cash
  (`platform_held=false`, note "collected by the landlord"). Data:
  `scripts/oct1_prepaid_check_money_not_paid_out.ts` flipped the four rows and
  removed their owner-share ledger rows. Next-payout card now: $539 (Robert
  Housley RV 14, card) ready; Fierro/Cox ACH clearing. Tests: prepaidRelease
  (+2; fixture now seeds an ACH remittance for the held case).
- **Outstanding Balances page = property folders** (`BalancesPage.tsx`): one
  folder per property, closed until opened, no property dropdown; people
  alphabetical by last name inside; folder line shows count and total. A person
  at two properties appears under each with only what they owe there.

- **Dashboard banner: outstanding ≠ delinquent** (Nic). Was "51 delinquent
  units — late fees accruing on 7". Neither was true: 51 = anyone owing
  anything (all due today), and the 7 were waived September bills counted
  because their October bill sat beside them; every lease at both parks carries
  a $0 late fee. Now three live numbers off open charge rows with each lease's
  own grace period (`routes/landlords.ts`): `units_owing`, `units_past_grace`,
  `delinquent_units_accruing_late_fees` (past grace AND fee on AND > $0 AND not
  exempt AND no first-bill waiver). Banner: "N units with an outstanding
  balance — M delinquent (past the grace period). Late fees accruing on K." /
  "none past the grace period yet". Migration `20261001120000`: the
  `units.status='delinquent'` trigger now uses the lease's grace days instead
  of a fixed five. `lateFees.ts` + the generator's first-bill check exclude
  VOID history invoices (Country Acres had ten). Tests:
  `dashboardPropertyFilter.test.ts` +2.
- **Reload keeps the sub-tab** (Nic, clarified: pages with in-page tabs —
  GoldSign → Documents, Master Schedule → Timeline — snapped back to the
  default tab on reload because the tab was component state). New
  `apps/landlord/src/lib/useUrlTab.ts` keeps the tab in the address
  (`?view=history`, replaceState, default writes nothing, bad value → default),
  the way PropertyDetailPage already did. Converted: SchedulePage (view),
  ESignPage (tab), POSPage (tab), MaintenancePage (view), FrontDeskPage (tab),
  BankPage (tab), BankFeedPage (view), BackgroundChecksPage (tab). Verified in
  the dev build: Master Schedule → History → reload → still History. Modal and
  form modes (lease agreement/notice, sign type/upload, invite screen mode)
  deliberately left as state. The Financials hub tabs were never affected —
  they are routes.
- **Work trade switches, for the record:** "Trusted — no hours" on the Work
  Trade page = `tracks_hours=false` (what all nine of Nic's agreements are:
  nothing logged, nothing approved, month closes covered). A TRACKED agreement
  is monitored by default (landlord approves hours); its `trusted` flag (S652)
  makes logged hours count immediately and lets the person check off others'
  jobs. Field permissions (Read meters…) are separate and per agreement.
- **Both of Nic's parks have late_fee_initial_amount = $0 on every active
  lease** (Mountain View 43, Oak Park 24). Late fees cannot accrue there until
  the leases carry an amount. Flagged to Nic, not changed.

## Afternoon batch (built, tested, reviewed; one deploy)

- **Front desk: every balance row opens its line items.** `BalanceBreakdowns.tsx`
  (invoice lines incl. late fees, pay-link items, register-ticket items) is
  shared by the Outstanding Balances folders and the Front Desk list ("▸ what's
  on it"). Nic: "there's no line item breakdown — that's an important thing."
- **Card on the counter reader (Nic's 7 answers, memory
  `gam-counter-reader-design`).** Record-a-payment window: "Card on the reader"
  shows balance + card fee (3.5% + $0.55, the online rate, the customer's),
  sends the total to the S710, waits, books it like an online card payment but
  `payment_channel='in_person'`, then captures; the normal webhook settles.
  Routes `/payments/:id/reader/*` and `/payments/reader/intents/:pi/*`
  (`routes/payments.ts`), `createRentReaderPaymentIntent` (posTerminal.ts),
  `rentCharge.ts` `card_present` / `dryRun` / `existingIntent`. Capture failure
  unwinds every row. 9 tests in `paymentsReader.test.ts`.
- **Paid by, everywhere.** `payments.payment_channel` (migration
  20261001130000, applied); `paidByLabel()` in shared; "Paid by" column on the
  landlord history and the tenant history ("Card · online" / "Card · in
  person" / "Pay link · in person (card|cash)" / Cash / Check / Bank).
- **The reader is online.** tmr_GrjAfQuPEDIxcR, serial STR71Z1H614000756, at
  Mountain View's Stripe location; Stripe registered it from the dashboard
  purchase, so there was never a pairing code to enter. Only one S710 exists;
  Oak Park gets none.
- **Live bug at the reader: "Reader not registered to landlord."** The
  register's process/capture/cancel/get took the company from Nic's account's
  HOME company (resolveLandlordTarget fallback — the calls name no property).
  Now the company comes FROM THE INTENT (`ownTerminalIntent` in pos.ts) and is
  only checked against what the caller may act for; a stranger gets 404.
  Also: one registered reader auto-selects (register and the payment window);
  the chooser appears only with a choice to make.
- **"Your deploy signed me out" — it was the 7-day pass.** Sessions were a fixed
  7-day JWT from the last password login, never renewed (Nic's OTP history: a
  login every few days). Landlord, tenant, POS portals now renew a pass older
  than a day on load and when the tab comes back into view
  (`sessionRenewalDue` in shared → `POST /auth/refresh`, which now REBUILDS
  claims from the DB via `loadUserForSession`/`sessionClaimsFor`, shared with
  /login). Admin, business, pm-company, admin-ops still carry the fixed pass.
- **Phones "booting people out" at the 2FA code.** The pending code step was
  per-tab (sessionStorage); coming back through the email opened a new tab.
  Now localStorage (any tab resumes). And Nic chose **option 1** for the bypass:
  the bill email's Pay now link is `/login?ef=<email-factor token>&to=/payments`
  — opening it proves the inbox, so the password alone finishes sign-in; an
  authenticator app is never bypassed; foreign/expired → the normal code
  (`signEmailFactorToken` in emailOtp.ts, `payNowLink` in invoiceNotice.ts,
  tenant LoginPage reads/strips `ef`/`to`, `ToSignIn` remembers the page a
  signed-out visit was headed to). Reminders/late notices do NOT carry it yet
  (Nic didn't answer that half).
- **Adversarial review (26 agents, 4 lenses) before shipping: 17 confirmed, all
  fixed.** Open redirect via `/login?to=//host` (now `safeLanding()`); session
  renewal outliving a password reset (`users.sessions_valid_from`, migration
  20261001140000, checked at /auth/me + /refresh); the webhook had no
  `card_present` branch so a tapped card would never settle; the reader
  charged the gross balance while the desk shows the net of credit (now netted,
  409 when credit covers it); the desk quoted a client-side total (now
  `GET /payments/:id/reader/quote`); a failed capture left rows + a hanging hold
  under a "booked" label (capture now INSIDE the booking transaction, intent
  reverted to pending and canceled); multi-lease households were half-charged
  (one tap per lease); the cancel route trusted a body reader id; modal
  lifecycle (unmount cancels, attempt token, loading/error states).
- Tests: auth (64), pos (96), payments (89), paymentsReader (13), webhooks (28),
  totp, invoiceNotice (+1), rentCharge, tenants, pos-parity — green.

## Evening: NO DEFAULT COMPANY (Nic, DIRECTIVE — reverses S652)

Nic at the register: "Resume and Discard buttons are not doing anything" — the
open tab belonged to Mountain View, the row-keyed register calls named no
property, and the S652 "home company" fallback answered Oak Park, so the
server said "Session not found" (and 404'd adding items to the tab, and the
reader "not registered"). Nic: "My account should not have a default company…
None is the default. They should not be merged in any way." (memory
`gam-no-default-company`).

- `resolveLandlordTarget`: fallback removed; `homeLandlordId` gone from the
  session (middleware/auth.ts). Explicit → property → unit → lease → ask.
  New `landlordForRequest(req, what)` does that order; 25 route sites in
  landlords/esign/background/documents now use it.
- POS router middleware: the ROW the URL names (`ROW_TABLE`) says which company
  when no property does. Register client sends propertyId on settings /
  vendors / card-on-file.
- Announcements with no property fan out to every company the account owns.
- Pool outreach with no unit shows the company picker; Settings' PM-default
  names the page's company.
- `EntityPicker`: auto-fills only one company; two or more start on "Choose a
  company…" (the first-in-list default is gone).
- Tests updated from "lands on the founding company" to "asks" (expenses,
  monthly P&L, team invite, register list); new register test: a two-company
  account opens, lists, adds to, and voids a tab at its second company with
  no property named.
- NOT done: FlexChargePage POST /landlords/pos-customers (feature is off)
  names no company; the CSV import pages let Validate run before a company is
  chosen (the server answers "choose which company" — fine, but the button
  could disable). Admin/business/pm-company portals untouched.

## Night: the reader's screen, the charge that survives, the customer base

- **Reader screen (Nic): name + breakdown.** Before the reader asks for the
  card it shows a cart: at the desk "Rent — Selene Arvizu (RV 39)", each
  charge by name, "Card processing fee", total; at the register each item
  with quantity, tax, card fee, total. Server-priced (`showCartOnReader` in
  posTerminal.ts; the register's /process re-prices the cart and refuses a
  changed one with 409).
- **Timeout keeps the charge (Nic: "I don't want it to void the charge").**
  A timed-out / declined / canceled prompt is CLEARED off the reader
  (`cancelReaderAction`, via `/clear-reader` routes); the charge and the cart
  stay; "Charge" / "Send again" puts the same charge back (`/resend` at the
  desk re-checks the balance; the register's /process re-checks the cart).
  Voided only when the cart changes or the sale is abandoned. Wait is 3 min.
  Live: Nic's stuck "$4.19 — tap or insert" was cleared by hand (cancel_action)
  while this shipped.
- **Customer base from the card (Nic's answers).** The CARD is the customer
  (Stripe fingerprint; `pos_customer_cards`, migration 20261001150000; email
  on pos_customers now nullable; `created_from`). The printed name is the
  record (`nameFromCard`). After a card sale the READER asks — the customer's
  own screen, their own finger — "Save this card for next time?" (Yes / No
  thanks) and, optionally, an email for the receipt (Stripe `collect_inputs`,
  called over REST because SDK 14.25 predates it). Yes attaches the tap's
  `generated_card` (no second authorization — verified in Stripe's docs:
  "A successful card_present payment returns a reusable card PaymentMethod in
  the generated_card attribute"; only the SetupIntent "save without charging"
  path would cost one). A typed email becomes the customer's and the receipt
  goes out (`emailReceiptForSale`; the clerk can also send it from the receipt
  panel). Second card = separate record (Nic: leave them separate). Receipt
  panel: "Customer: Jane Doe · card ending 4242 · new customer / N previous
  purchases" + History (history filters by customer, names the customer).
  "+ New customer" at the register for cash people; a picked customer rides on
  every sale.
- **First live tap (Nic, Apple Pay, $0.91, pi_3ULsHnDNEru9AEpK1xM6I1Sp):**
  `generated_card: None`, `cardholder_name: None` — Stripe produced no reusable
  card because the intent never asked for one, and wallets carry no name. The
  customer was still created from the card (visa ····9767, "Card Customer")
  and no prompt ran (nothing to keep). Fixed: register intents now carry
  `setup_future_usage: 'off_session'` and the register's reader call passes
  `process_config.allow_redisplay=always` under API 2024-09-30.acacia (the
  SDK is pinned to 2023-10-16; the one call names its version). Nothing is
  KEPT without the customer's Yes (an attach + `allow_redisplay` update over
  REST). The reader now asks only for what the tap lacked: keep the card
  (when reusable), a name (wallets never carry one), an email (when none);
  a typed name replaces the "Card Customer" placeholder. The account's
  default API version is 2026-01-28.clover, so the REST calls (collect_inputs,
  payment_methods update) are current.
- **Still to confirm on the next live taps:** a PHYSICAL card tap shows
  `generated_card` + the printed name; an Apple Pay tap with the flag now
  yields a generated_card (Stripe: wallets can be saved, `allow_redisplay=
  limited`); and that the S710 displays the `collect_inputs` prompt.

## Late: Customers tab, per-sale fixes, the open-tab banner

- **"Discard needs three clicks / Resume does nothing" (Nic, live):** three
  stale EMPTY tabs were open at Mountain View; each Discard voided one and the
  banner showed the next; Resume of an empty tab restored an empty cart. Now
  empty tabs clear themselves on load, the banner counts the rest ("3 open
  tabs"), Discard clears them all in one click.
- **Apple Pay "card ending 9767":** the phone's device number, not the plastic
  card's — expected. A wallet tap and the physical card are two records until
  merged.
- **Customers tab** (`GET /pos/customers?propertyId=`): every customer of the
  company with email/phone, cards (on file or not), purchases, last purchase,
  total spent; "possible duplicate" = same email or same phone (digits only),
  never the same name (`pos_customers_email_landlord_uniq` already forbids two
  live records with one email per company). Click a row: edit name/email/phone
  (`PATCH /pos/customers/:id`), Purchase history (History filtered), Fold
  into… with a two-step confirm (`POST /pos/customers/:id/merge`;
  `mergePosCustomers` moves transactions, cards, tickets, pay links, sessions,
  invitations, charge account; the folded record is archived and gives up the
  email/phone the survivor took).
- **Email match = same person:** a card-made record that gives an email
  another live customer already has (receipt box at the desk or typed on the
  reader) is folded into that customer automatically.
- **History row:** "Customer: … [Change]" (`PATCH /pos/transactions/:id/
  customer`, resident or customer of this company) and "Email receipt" (resend
  to any address; the address becomes the customer's when they had none).
- Agent parity names the four new mutating routes.

## Evening gate flakes: "today" in UTC (5 pm – midnight Phoenix)

Three consecutive gate runs after 5 pm failed on DIFFERENT tests
(applicationLeaseDraft, utilityBilling ×2, bookingLeaseBilling), each
"expected 2026-10-01 to be 2026-10-02": the test computed today with
`new Date().toISOString().slice(0,10)` (UTC, already tomorrow) while the
database's CURRENT_DATE is Phoenix. Fixed the three by taking dates from the
database. 24 test files still carry the pattern; ~20 source sites do too
(scheduler.ts checkIn, subleaseEndOfTerm.ts today, subleases.ts consentDate,
inspections.ts scheduledFor, background.ts checkIn, books.ts/reports.ts
ranges) — a real evening bug class: `generateFinalUtilityInvoice` dated a
move-out invoice TOMORROW after 5 pm (fixed: `todayIn(property.timezone)` in
lib/timezone.ts). Nic's one deploy for the day shipped with `--skip-tests`
after every suite the batch touched was run by hand (pos, paymentsReader,
actionGap, utilityBilling, invoiceGeneration, workTrade, notifications,
background, auth, landlords, esign) — because the gate cannot pass in that
window until the pattern is gone. NEXT: sweep the 24 test files to the
database's date and the source sites to `todayIn(property tz)`; never run the
full gate between 5 pm and midnight until then.

## Evening, live (deploys 13-15, Nic's word)

The counter reader, as Nic asked: the breakdown (customer name on a $0 first
line, each item, card fee, total) goes on the S710 while the cart is rung and
follows every change; Charge (or Send at the desk) keeps it up 30 seconds for
the tap (`TAP_WINDOW_SECONDS`), then charges with the tapped card; "They tapped —
finish now" / Cancel on the register. Measured live: $0 lines are accepted; a tap
on the breakdown shows "Completing order"; the reader object does NOT change on a
tap (no tap signal exists). Customer picker on every sale (this property's
residents + this company's customers); after a sale the customer is TYPED IN
(first/last/email/phone) on the receipt screen and in History — never a dropdown.
Money locks: tender, Clear, hold-for-delivery and pay link are locked while the
reader holds a charge; any change ends the window as Cancel; a reader charge is
recorded only as card (server refuses otherwise). Apple Pay never sends a
cardholder name; chip inserts usually do.

## Overnight (Nic away) — built, tested, reviewed; NOT deployed

Nic: "finish testing all your other bugs… make sure that point of sale
standalone is byte identical to point of sale on the landlord page." Worked in
rounds: fixers on disjoint files, each change attacked by an independent
reviewer, findings fixed in the next round. Full API suite run at the end (see
below). Everything is committed and pushed; nothing is deployed.

**Applied to prod tonight (additive migrations, safe with the live build):**
`20261001160000` email archive matches the live table; `20261001170000`
properties refuse an unknown time zone (prod has none); `20261001180000` one
login per email in any letter case (prod has none). Also applied to gam_demo.

**Shipped in code (needs deploy):**
- POS parity: every file the register reaches is byte-identical in both apps
  (lib/api, AuthContext, dialogs were drifted and are unified); the guard test
  now follows the imports. Register + desk can't inherit each other's tap.
- Dates are the property's, not UTC's: 58 files. Real bugs fixed with it:
  monthly statement/P&L pulled next month's rent in; balance sheet and to-date
  ranges dated tomorrow every evening; e-sign screening gate let an unscreened
  applicant through after 5 pm; credit-record tier marked 5 pm–midnight
  payments late; P&L dropped the last day; bank-feed books-start cutoff never
  applied. The test gate now passes in the evening.
- No-default-company fallout: Expenses, bank reconciliation, bookkeeper invite,
  documents, e-sign to typed emails (now asks WHICH PROPERTY), FlexCharge,
  lot-rent; CSV import waits for a company; PM portal asks which company.
- Oak Park late digest = true open balance, one line per person (was rent only).
- Reminder emails carry the bill-link sign-in factor.
- Reports: one definition of landlord income everywhere (GAM's fees and held
  deposits were counted as landlord income).
- Work trade: an hour-tracking agreement's end no longer bills the shortfall
  twice; re-running a month close no longer counts hours twice; late approvals
  count.
- Jobs: business invoicing fee crash, compliance archive, Stripe one-bank
  default, S638 on move-in bills, session renewal on business/PM portals.
- SECURITY (pre-existing holes, all in production today — deploy soon):
  CSV import could write into another landlord's property and attach another
  landlord's own login as a tenant and mail its activation link to an
  attacker; invite/accept-invite, PDF intent resolve, contact-address change,
  utility agreements, team invitations and e-sign (signing tokens returned to
  every signer on GET /documents/:id; any login as landlord signer) could hand
  one company a password or signing link for another company's person; "add
  owner" added any landlord as co-owner with no consent and made the adder their
  referral upline (commission). No sign of misuse in prod (co-owner links are
  Nic's own people).

**Taken back out (saved on branch `wip/credit-netting-s654`):** a redesign of how
paid-ahead and landlord credit are netted and placed (it began as the MH 25
fix). Four review rounds kept finding money edge cases (credits covering the
whole bill, neighbor utilities, GAM fee rows, mixed GAM-held/check credit, an
in-flight ACH retry settled from credit). Main runs today's live payment logic
plus two harmless fixes (autopay skips work-trade lines; the tenant assistant
counts a bounced payment once and never quotes work-trade lines as owed).

### Morning (Nic back, 10/2)
- Landlord dashboard showed black in Safari; a refresh fixed it. Every request
  it made was answered; cause not reproduced (no Safari access, no crash report).
- Platform fee "$136 on 67 occupied": the bill was right (Oct accruals: Oak Park
  24 + Mountain View 44 = 68, the owner-use space included); the card printed the
  rent-roll count. Fixed: owner-use counts as occupied on the dashboard, and the
  fee card shows the count the bill used. Owner-use units now also block the
  landlord's own reservation form and the overlap check (the public site already
  excluded them via is_bookable).
- Add-owner referral restored (Nic: the adder is the referrer): set when the
  invited owner ACCEPTS, to the company's founding owner, first-touch wins.
- MH 25's $10 credit: check #170, recorded 9/9 for $470 against the $460
  September rent. Nic confirmed the $470 is real (paid ahead). The $10 credit
  STAYS.
- Country Acres late fees: NOT waived (Nic). Blu can credit a bill one-off.
- **Cash/check fee RIPPED OUT (Nic: "There's no fee. Paying cash or check is
  free.")** The retired fee machinery (already $0 since S630) is gone: the
  MANUALPAY fee row, the first-payment waiver, the fee-payer toggle on the
  property page, the absorbed-fees card and endpoint, every fee field in API
  responses, and the $6 fee and waiver text in both Terms of Service. Committed,
  NOT deployed.
  **After that deploy:** one contract migration drops
  `property_allocation_rules.manual_fee_payer` (and its CHECK), removes
  'MANUALPAY' from the payments entry_description CHECK and
  'manual_payment_fee' from the landlord_gam_charges kind CHECK (prod has 0
  rows of either), then delete the two `manual_fee_payer` strip lines in the
  properties route, run migrate + db:dump-schema, and re-run
  `npm run agents:ingest` so the tenant agents stop quoting the old $6 line.

### Decisions for Nic (numbered; recommendation first)
1. **Deploy** the overnight batch — the security fixes are the reason.
2. **Country Acres late fees** — Blu's answer before 10 pm Oct 5 Arizona time
   (11 × $50). Stamp MH 15 (Mike Boyd) exempt under S638? (one invoice).
3. **Credit netting (MH 25 and every paid-ahead tenant):** today the bill email
   nets paid-ahead credit and the portal does not, so they show different
   numbers. Options: (a) portal matches the email for the simple case only,
   (b) the full redesign on the branch after a design review, (c) email stops
   netting. Recommend a short design session before any code.
4. **Renewal billing:** a mid-cycle renewal bills a full first month the old
   lease already billed. Options explored and their edge cases are in the
   round-6 notes; Nic sets the rule.
5. **Bulk tenant CSV** emails every imported tenant at once (conflicts S647).
6. **Reports basis:** confirm cash basis (by settle date) — some reports go by
   due date.
7. **FlexPay** (0 enrolled): the tenant pull collides with the rent row and
   debits with no payment row. Fix before anyone enrolls.
8. **Bank feed cleanup** (prod write, needs OK): 69 pre-books-start rows and 91
   relink duplicates on the active PNC connection sit in needs_review.
9. Delinquent mark counts rent only (utility-only debtors never marked).
10. Session renewal for admin / admin-ops / books (super_admin would roll).
11. Pay-now button on the "retries exhausted" email.
12. Old bank detached when a new one is added, before it verifies.
13. MH 25 overpaid $0.35 card fee — refund?
14. Month-to-month renewals can't be sent (overlap check).
15. Registration auto-claims co-owner invitations before email verification.
16. Invite responses still return the activation link to the inviter for a
    brand-new account (InviteTenantModal's copy box) — keep or email-only?
17. POS pay-link people search shows other companies' residents' name/phone
    (Nic agreed earlier; conflicts with data isolation).
18. **Security punch list still open** (final audit, all pre-existing): onboard
    routes attach another company's resident with no consent; tenant profile
    shows a resident's cross-company history; property transfer needs no buyer
    consent; waive-screening is platform-wide; a property manager can redirect
    the owner's signing email; booking screening reveals other companies'
    background checks; credit-settled rows and shortened stays count as income.
    Recommend fixing these next, same review loop.

## Still open

- **Lots 22 and 24 are marked OUT OF SERVICE** (9/30, by the run's stuck-meter
  rule: same read on an occupied lot twice). Blu has an unread "Water meter not
  reading" notice for each. Nothing bills from either meter until a real read
  is entered and "Mark repaired" is clicked on the Utilities page. The 9/30
  reads were entered under Blu's login during S653 from the list I had; lots
  22 and 24 went in equal to August.
- **TruBlu (Country Acres) has no Stripe Connect account and no debit method.**
  Tenant payments there will be platform-held with an admin alert each (not
  lost), and the $24 October platform fee cannot be debited. Blu must link his
  bank before the first Country Acres payment lands.
- **Country Acres late fees fire the night of Oct 6** ($50, grace 5) on 11
  unpaid Oct 1 bills (MH 01, 11, 15, 17, 18, 21, 22, 24, 28, 29, 30 = $550 if
  nobody pays): `onboarding_late_fee_waiver` is NULL (Blu could never answer —
  the question only showed while the onboarding window was open, and it closed
  9/14, two days before the question shipped). Overnight build: the question
  now shows for any property where it is unanswered (Tenant Onboarding page).
  The void-history count was already fixed (061e2f5, live); overnight added the
  tests. MH 15 (Mike Boyd) started 9/25 and would be exempt under S638 (after
  the 20th) but his bill was written by the move-in bundle before that rule
  reached it — code fixed overnight; his one invoice needs Nic's OK to stamp.
- Fixed overnight (see Overnight section): Oak Park late digest, business fee
  job crash, compliance archive, Stripe one-bank default. MH 25: the bill
  email was RIGHT ($450); the tenant PORTAL asked $460 (ignored the $10 paid-
  ahead credit). The $10 is still on the account for November. Not fixed on
  main — see Overnight, decision 3.
- Shane Rueff, Kyra Smith, Jolyn Whitfield sign their purchase agreements.
- Myria's contract record is $24,000 / 120 × $200; the agreement Blu signed says
  "$12,000 + taxes" and the sheet says $650 × 5 years (= $12,000). Monthly is the
  same; the payoff is wrong. Nic to confirm with Blu.
- Lot 17 (Cameron Valdez) 19,800 gal / $326.70 and lot 21 (Skinner) 10,000 gal /
  $165 — flagged in S653, unanswered.
- Carried from S653: waitlist design; Oak Park RV 24 September water share.
