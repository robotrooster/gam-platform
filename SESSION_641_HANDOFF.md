# SESSION 641 HANDOFF — read this FIRST

Supersedes `SESSION_636_HANDOFF.md`. Durable decisions live in the memory system
(auto-loads via MEMORY.md); this file is the pointer to where the *money* and the
*live state* stand right now.

Everything below is **committed and deployed** unless a line says otherwise.

## Where this left off
`54fcf45` — the localhost-link fix — deployed green at 10:26 Phoenix (7,120 tests,
all surfaces in sync, API healthy). **Lisa Scheeler's invitation was re-sent on
the new code and Resend reports it `delivered`**: it now carries
`https://landlord.goldassetmanagement.com/invite/<token>`, expires 9/18, and her
old localhost token is dead. She is `onsite_manager` at Mountain View and has not
accepted yet — when she does, spot-check that she sees POS, the schedule, the
front-desk list, and only the outstanding-balances and payments tabs.

Nothing is uncommitted. Nothing is mid-deploy.

## Why the localhost links kept happening
Not carelessness — structure. Every link builder invented its own env name at
the call site in the shape `process.env.SOME_URL || 'http://localhost:3001'`.
`LANDLORD_PORTAL_URL`, the one behind Lisa's invitation, **has never existed in
any environment**; the real variable is `LANDLORD_APP_URL`. So the fallback was
not a safety net, it was a silent default that only showed itself in somebody's
inbox. Every team invitation GAM has ever sent was dead on arrival.

`apps/api/src/lib/portalUrls.ts` now resolves one canonical name per surface, and
under `NODE_ENV=production` there is no localhost fallback at all — a missing
variable yields the known production host and logs loudly. `portalUrls.test.ts`
greps the source for the bad shape so the next one cannot ship quietly.

Also missing from `.env` and now routed through the resolver or known-good:
`VERIFY_EMAIL_URL`, `RESET_PASSWORD_URL`, `LANDLORD_SIGNUP_URL` (its old fallback
`https://app.goldassetmanagement.com/signup` is an unreachable host),
`CUSTOMER_PORTAL_URL`.

## Money, as of this morning
- **Mountain View has been paid once: $2,638.11, status `paid`** — two Stripe
  transfers (`tr_…e4KXyvjr` $2,049.11 on 9/4, `tr_…BRrFFnW8` $589.00 on 9/3).
  That payout only went through after the index fix below; before it, **no
  landlord with more than one card payment could ever be paid out.**
- 52 settled payments totalling $14,166.69 in the last 60 days; $4,830.15
  pending, $460.00 clearing.
- Next automatic run fires **6pm Phoenix Wednesday** so Stripe books it
  **Thursday**. This is the first fully unattended one — watch it.

### Payout cadence as it now stands
Weekly only; thresholds are retired, not disabled. `$100` floor with a 30-day age
override, a 5-day minimum interval instead of a calendar rule, and a **month-end
sweep** that bypasses both guards so the balance lands by the last business day
of the month and months do not roll into each other. All of it in
`apps/api/src/jobs/autoPayouts.ts`; the landlord dashboard reads the same
`nextPayoutDateUtc()` the engine does, so the card and the engine cannot drift.

Note `PAYOUT_TARGET_DOW` names the **UTC** day the payout is booked. Nic's open
question — whether the Wednesday-evening firing is what he wants once he sees how
Stripe actually handles it — is still open by his own choice.

## Two bugs worth remembering because tests did not catch them
1. **`idx_user_balance_ledger_stripe_transfer_id` was UNIQUE.** One passthrough
   transfer stamps many ledger rows, so any multi-payment batch rolled back.
   Found only by pushing a disbursement by hand. Migration
   `20260911000000_one_transfer_covers_many_rows.sql`.
2. **`getLandlordIdFromReq` returned a NULL `profileId`** (S633: a landlord's
   profileId *is* NULL), which killed the Team page for every landlord. Nineteen
   green tests missed it because the fixtures still signed the pre-S633 token
   shape. When a test suite is green over a schema change, check what shape the
   fixtures sign.

## Checkr
The webhook was live the whole time and **500ing on 75 of 79 deliveries**. I
reported the opposite for most of a day because `grep` treats `/tmp/gam-api.log`
as binary (one non-UTF8 byte) and silently returned nothing — every "zero hits"
search was an artifact. Use `grep -a` on that file. Nic found the truth in the
Checkr dashboard, not from me.

Fixed: acknowledge-don't-retry on unknown event types (`parseWebhook` returns
`| null`), the archive was storing raw Buffers so it could not answer anything,
`report.completed` carries a *report* id not an order id, and a **10-minute
poller** (`backgroundCheckSync.ts`) so a screening no longer depends on a webhook
arriving at all. Verdict application is shared between webhook and poller in
`backgroundApplyUpdate.ts`.

## Delinquency now means what Nic said it means
> "it needs to read any outstanding charges… aside from propane that has an
> installment loan or installment plan" — later widened to *any* installment
> structure.

`v_installment_payments` is the single definition of "this charge is on a plan."
Work-trade-suspended charges are excluded too. **The live count reads 3**, which
is what he expected, including RV 49's electricity.

## Work trade
Subtracted from Expected Monthly Rent and Outstanding *everywhere*, and carried
as its own "revenue not coming in" figure. `payments.work_trade_suspended_at` is
the primitive. "Those people are not gonna be paying. It's not outstanding."

## Utilities
- Occupied means **not vacant** — any status. A stuck meter on an occupied spot
  bills `comparable_low` (Jared Coyle, RV 23 Mountain View: 120 kWh = Randall
  Cox's real usage, $25.20).
- An `owner_use` unit still records usage as **owner absorption** on both the
  stuck and the normal submeter branch: a free spot is money not coming in, but
  utilities paid on someone's behalf are real money going out.
- Onboarding tenants are exempt from late fees, and the waiver is now asserted in
  the engine against facts rather than a flag. The NULL-safe `COALESCE` there
  matters — a bare comparison killed every service-agreement late fee.

## Emergency contacts
Built end to end: 31 imported from lease text, 6 fillable blanks, a Front Desk
sub-tab sorted missing-first, an annual ping (`STALE_AFTER = 1 year`, asked at
most every 90 days), and the resident's own side in the tenant portal. Parsing
was measured against 33 real lease strings — 13 complete, 11 name-only, 4
phone-only, 5 unusable — so do not expect the importer to do better than that.

## Lisa's scope (built, pending her accepting a working invite)
POS view, master schedule, front desk to-do list, outstanding balances and
payments tabs only. She can record cash payments (`front_desk.view`,
`take_payment`). She **cannot** issue credit or import payment history, and has
no reports, expenses or bank access.

## Standing rules I broke this session — do not repeat
- **Never run vitest while `deploy.sh` is running.** I did it four times and
  killed four deploys. Check `pgrep -f "bash deploy.sh"` first, every time.
- **Never edit source while a deploy's test suite is running** — torn tree,
  twice.
- `DB_NAME=gam_test` for every vitest. `gam` **is production**.

## One small thing I found and did not fix
`email_send_log` records a **suppressed** email as `status = 'sent'`. In
`services/email.ts` the suppressed branch leaves `status` at its initial value, so
a message that never left the machine is indistinguishable in the audit trail
from one Resend delivered. It only bites outside production (that branch runs when
`NODE_ENV` is not production, or when there is no `RESEND_API_KEY`), which is why
I left it: the honest fix is a `'suppressed'` status, and the table's CHECK only
permits `sent | failed`, so it needs a migration and a deploy I do not have a
go-ahead for. Whoever picks it up: one migration widening the CHECK, one line in
the `else` branch at `services/email.ts:184`.

You can see both rows of this in Lisa's history — 10:26:33 is the suppressed dev
run logged as `sent` with no provider id, 10:26:41 is the real one.
