# SESSION 536 HANDOFF

Theme: **POS/business platform hardening** — one-credential POS portal
(business mode live), all-money-through-GAM, business pricing locked,
register UX walk fixes, SMS removal, browser-neutral dialogs. Continues
S535 (uploads security lockdown + renewal flow, same working tree).
(The HOA project's "01" handoff is a separate repo/numbering — ignore it
for session numbering here.)

## Shipped (S535 tail + S536 — all verified live + suites green)

### Security / e-sign (S535 tail)
- ZERO static /uploads (memory: gam-nothing-public-rule). Every file via
  authed routes; demo template PDFs are james@demo.dev test data served
  like any lease doc; esign files auth covers templates + team + fixes the
  shared-base LIMIT 1 bug; PDFCanvas sends Bearer (uploaded-template
  preview un-broken). Listings API: requireAuth + tenant needs approved bg
  check. Unit photos via authed route + AuthImg.
- Tenant-never-signs-first: 4-layer enforcement (see W-58).
- Renewal lifecycle (W-59): own deadline/reminders; MTM = end of month
  after CREATION (not send — they're the same moment; sent_at anchor left
  a no-deadline hole if send hiccuped).
- Email: suppressed outside production (EMAIL_SEND_LIVE=1 override) — demo
  bounces were burning domain rep. Prod plist sets NODE_ENV=production →
  auto-live at launch flip.

### POS portal = the front counter product (memory: gam-pos-identity-…)
- Business logins (business_owner/business_staff) get the business-mode
  register (port of business POSPage → apps/pos/src/pages/
  BusinessRegisterPage.tsx — KEEP THE TWO COPIES IN SYNC). Landlord roles
  unchanged; tenant/fitness get a deny screen. One-way access only.
- Register parity everywhere: stock-capped cart, typeable qty, no icons.
- W-63…W-69 in FINAL_WALKTHROUGH.md: subtab consolidation, email-PDF
  receipts, tips toggle, reader payments, customers tab/picker/edit,
  cash report, account menu.

### Money flow + pricing (Nic-locked; memory updated)
- Business POS terminal + invoices = platform destination charges; Friday
  auto-payout sweep now includes businesses (jobs/autoPayouts third
  candidate kind; webhook-audited like PM companies).
- Readers now register on the PLATFORM account inside a per-business
  Stripe Terminal Location (businesses.stripe_terminal_location_id;
  created from the business address on first pairing).
- PLATFORM_FEES: BUSINESS_TERMINAL_APP_FEE 2.9%+10¢ · BUSINESS_INVOICE
  3.25%+30¢ (Claude-picked to clear Stripe cost — Nic hasn't explicitly
  blessed these two numbers; flag if revisited) · BUSINESS_INVOICING_
  MONTHLY $10 (usage-based, jobs/businessMonthlyFees.ts, account debit on
  the 1st, daily retry of pendings).
- businesses.card_fees_paid_by toggle → server-side surcharge on terminal
  charges; card_surcharge recorded per txn (receipt PDF omits it — minor).
- Terminal-paid sale recording VERIFIES the PI (metadata + succeeded +
  exact amount incl. surcharge). Hardware tap test pending Stripe
  Terminal hardware + live keys (DEFERRED vendor items).

### SMS removal (Nic-locked; memory: gam-pos-identity + no-native-dialogs)
- services/notifications stub + all sendSMS args gone; migration
  20260711120000 dropped notifications.sms_sent/sms_sent_at +
  notification_preferences.sms_enabled; routes/agent tool/frontend
  toggles cleaned; tests updated.

### Infra (memory: gam-studio-selfhost)
- com.gam.watchdog: 5-min revival of launch-set dev servers (tested by
  killing tenant). com.gam.launchset got AbandonProcessGroup (launchd was
  reaping its own children — the "everything died overnight" bug).
- Preview isolation: 31xx preview ports (landlord-preview 3101 / tenant
  3102 / admin 3103 / pos 3105 in ~/.claude/launch.json) + CORS entries —
  previews DUPLICATE portals now, never take over 30xx.
- Backup: uploads→iCloud switched to tarball copy (launchd TCC blocked
  rsync into Mobile Documents); nightly all-green since.

## Decisions made (all Nic)
Business/POS pricing (free register, $10/mo invoicing usage-based); all
money through GAM + Friday batch; card-fee payer toggle; no SMS ever;
no native dialogs ever (standing rules in memory); receipts email/in-app
only; POS customers: staff create+edit, owner-only delete, no hard delete
(GAM master copy), "Archive" wording banned in POS; renewals flow (W-59);
tenant never signs first; Vercel = straight to Pro AT launch (already
deployed on Hobby); Tap to Pay = later (native shell); storefront
subdomains + recurring product orders = future build (memory).

## Files touched (majors)
api: index.ts (no static uploads, preview CORS), routes/{esign, leases,
properties, businessPos, businessCustomers, businesses, businessInvoices,
notifications, pos}, services/{posTerminal, notifications, email,
subleaseDocuments-adjacent, recurringInvoiceSend}, jobs/{scheduler,
autoPayouts, businessMonthlyFees(new)}, migrations 20260711100000…150000.
frontends: apps/pos (main, POSPage, BusinessRegisterPage(new), api.ts,
Modal(new)), apps/business (POSPage, SettingsPage, AuthContext),
apps/landlord (POSPage, Layout, DashboardPage, LeasesPage, UnitsPage,
UnitDetailPage, ESignPage), apps/tenant (main, ProfilePage). Root:
start-launch-set.sh, watchdog-launch-set.sh(new), dev.sh (marketing
guard), deploy/backup-db.sh.

## Deferred / next session targets
1. **POS self-signup** (creates a lightweight business; EIN optional
   field) + **team management** in the POS portal — Nic has customers
   waiting.
2. **STR pricing build**: 5% fee for house/apartment short-stays; RV spots
   keep the 30-night aggregation (platformFee.ts seam confirmed clean).
3. Native-dialog sweep of tenant/landlord portals (UI batch, W-70).
4. Stripe live keys + webhook (Nic, blocked on sales-rep account
   migration) → then hardware tap test; dev→prod launchd flip at launch.
5. Storefront subdomains + customer-facing recurring product orders.
6. Confirm Claude-picked invoice/terminal fee numbers with Nic.
