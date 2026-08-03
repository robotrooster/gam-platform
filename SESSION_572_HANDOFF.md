# SESSION 572 HANDOFF

Continues the S570→S571 tenant-portal redesign (Nic driving). Very long session.
**Everything is UNCOMMITTED** — Nic decides the push. All work is typecheck-clean
across api/tenant/landlord/admin, tested where noted, migrations applied, and the
API rebuilt + `launchctl kickstart`ed live each backend change.

Master status + decisions: [[gam-tenant-portal-redesign]]. The tenant portal is
now **feature-complete except the inspections overhaul** (landlord-design-first).

---

## Shipped this session (all live)

### Maintenance redesign (finished from S571)
- Tenant form = **category dropdown** + description; title derived server-side.
  Tenant priority picker removed — **in-house LLM** recommends priority
  (`services/maintenancePriority.ts` → `chatCompletion`, heuristic fallback);
  landlord overrides. `recommended_priority` + `priority_source` columns.
- Landlord detail shows "AI recommended: X" + a priority/category override.

### Universal tenant email 2FA (reshaped mid-session per Nic)
- Started as "2FA on ACH/card save"; Nic simplified to **mandatory for EVERY
  tenant, always, from signup**. Enforced at login (auth.ts role check +
  flag canonicalize) + backfill migration. Dropped the conditional model and
  the `email_2fa_locked` column.
- Profile → Security: **informational** 2FA card above the password reset
  (email code, always on). Authenticator/recovery-code UI removed; standalone
  `/security` page retired → redirects to `/profile`. 2FA email = login email.
- Email copy "admin console" → "GAM". Webhook card-vs-ACH bug fixed (a card
  setup no longer marks ach_verified).
- **Infra:** test/seed domains (@tenant.dev/@demo.dev/@test.dev/@x.dev/@gam.dev)
  suppress the real Resend send and **log the sign-in code to /tmp/gam-api.log**
  (email.ts) — test logins work, no bounces. NOTE: live API runs
  NODE_ENV=production and really sends to real addresses.

### Communication dashboard (nav)
- One "Communication" nav item → a **Profile-style tabbed page** (Nic rejected a
  sidebar dropdown): Maintenance · Inspections · Entry Requests · **Documents** ·
  My Walkthroughs. Old `/maintenance` etc. routes still work.

### Tenant evidence media
- `maintenance_media` table (immutable — no delete route). Attach photos/video
  to a maintenance request, **addable even after it's closed** (comment input
  closes on completed; evidence stays open). **Live-camera capture only**
  (`CameraCapture` getUserMedia — no album). **"AFTER CLOSE" badge** when
  created_at > completed_at. `captured_live` flag + "live" tag. Worker/landlord
  fix photos use the same table (also live-capture) — landlord placeholder UI.

### My Walkthroughs — manual capture
- `tenant_walkthrough_media` table (immutable). Tenant starts a walkthrough
  manually (live capture); inspection videos shown below. `routes/tenantWalkthroughs.ts`.

### Entry-request reshape
- Entry ONLY via a **maintenance call or scheduled inspection** (anchors:
  `unit_entry_requests.maintenance_request_id`/`inspection_id`, at-most-one CHECK).
  POST derives unit/tenant/lease/reason from the anchor. Landlord create-page
  reworked to pick a call/inspection. **Verified live** (created one as James →
  DB row had the anchor + derived fields). 25 tests.

### Payment methods
- **One bank + one card**; adding one type never supersedes the other; a new
  card/bank **replaces the old of that type** (Stripe detach). **Default**
  selector, ACH auto-default, "Make default" to switch to card.
  `/stripe/tenant/confirm-card` + `PATCH /default-payment-method` + `isDefault`
  in the list. 29 stripe tests. (UI not browser-verifiable — Alice has no real
  Stripe PM — but shape confirmed 200 + tested.)

### Documents
- Folded into the Communication tab; `/documents` redirects there. Shows
  landlord-uploaded docs (agreements/notices/park-rules/receipts/checklists from
  the `documents` table) AND the **lease PDF as a downloadable row** (from
  `/tenants/leases` `documentUrl`; Lease page still renders it in-browser).
  Nic's real-flow rules applied: **no "pending signature"** (portal access is
  post-sign), **Active/Expired** status, **term (start–end)** + executed date,
  keep **expired** leases for history. Verified live (Download → lease PDF 200).

### Feature requests — both parties
- Admin **triage page** (super-admin, apps/admin, status dropdown). Landlord
  **submission** card on Settings (apps/landlord). Tenant capture already shipped
  S571. All → `feature_requests`. Verified: landlord submit → DB row.

---

## Migrations applied (all `20260731…`)
maintenance_recommended_priority, feature_requests, email_2fa_locked,
universal_tenant_email_2fa (drops email_2fa_locked), maintenance_media,
tenant_walkthrough_media, evidence_captured_live, entry_request_anchors.

## Remaining / next
- **Inspections overhaul** — the ONLY tenant item left, and it's **landlord-
  design-FIRST**: Nic designs the landlord template/agent-gap flow in a landlord
  walkthrough, THEN we wire the tenant capture UI. Don't build tenant side yet.
- **Parked:** landlord visibility of tenant walkthroughs (landlord portal);
  agent eval/retrain (Nic waits until all fixes done — the `fileMaintenanceRequest`
  tool changed: category in, model-priority out).

## Standing rule reinforced (S572)
Tenant portal only for remaining work. Landlord-side changes that are
structurally required (entry-create, evidence view, priority override) stay as
**functional placeholders**; Nic designs landlord surfaces himself, then Claude
reworks. Don't design landlord UI unprompted.

## State
UNCOMMITTED. Typecheck-clean everywhere. Tests green on touched suites
(maintenance 43, entry 25, stripe 29, emailOtp/feature-requests/walkthroughs).
Live API rebuilt + kickstarted. Demo tenant alice@tenant.dev has seed quirks
(active-but-unsigned lease, no real Stripe PM) — don't read those as bugs.
