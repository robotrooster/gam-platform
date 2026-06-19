# SESSION 506 HANDOFF

## Theme
Closed out the **booking-guest agent** track (the last unshipped agent piece)
and ran a full **knowledge-base audit + cleanup** of the CS-agent's 52 seeded
help articles. Agent-window work only.

> PARALLEL-WINDOW NOTE: a second window ran concurrently on **GAM-for-Business**
> (per-line discounts, business bookkeeping via the GAM Books engine) and
> authored **SESSION_505**. That window explicitly owns business-portal files;
> this window (S506) owns agent / guest-agent / KB work. No known shared-file
> collisions this session (my edits were bookingGuestTokens, units.ts guest
> routes, BookingsPage guest panel, ingestKnowledge, and KB content).

## Context reconciliation (important)
The S501–S504 handoffs listed three booking-guest items as "still open" that
were ALREADY built in the uncommitted tree:
- Guest stay page `/stay/:token` — DONE (`apps/marketing/server.js` →
  `renderStayShell`, the "Skye" chat widget POSTing `/api/guest/chat`).
- Host approve/decline change-request queue — DONE (`BookingsPage.tsx` +
  `bookings.ts` `/change-requests` GET/PATCH).
- Agent-permissions settings toggle — DONE (`PropertyAgentPermissionsSection.tsx`
  wired into `PropertyDetailPage.tsx:272`).
The handoffs were stale. The ONE real gap was guest-token **revoke** — built
this session.

## Shipped

### 1. Booking-guest agent — revoke (the last gap)
- **`revokeBookingGuestTokens({bookingId, landlordId})`** in
  `apps/api/src/services/bookingGuestTokens.ts` — sets `revoked_at` on every
  active token for a booking (each issue mints a fresh token without retiring
  the last, so revoke is all-or-nothing). Idempotent via `revoked_at IS NULL`.
- **`DELETE /api/units/:id/bookings/:bookingId/guest-access`** in
  `apps/api/src/routes/units.ts` — same auth as the existing issue endpoint
  (`requirePerm('guests.check_in','units.edit')` + `canManageLandlordResource`),
  returns `{revoked}`.
- **Host UI**: `GuestAccessModal` + a **Stay link** column on
  `apps/landlord/src/pages/BookingsPage.tsx`. Per booking: generate the stay
  link, show the QR (print/show on-site), copy link, re-email to guest (when
  guest_email present), and **Revoke access**. This wires the issue endpoint
  that previously had no UI, plus the new revoke.
- **Tests**: 3 cases in `bookingGuestTokens.test.ts` (revoke kills all links /
  idempotent / scoped to one booking).
- Validation: API `tsc` clean; landlord `tsc` + `vite build` clean;
  `bookingGuestTokens.test.ts` 10/10, `units.test.ts` 14/14 green.

### 2. KB audit + cleanup (52 → 46 articles, all accurate)
Full audit in **`KB_AUDIT.md`** (repo root). Five parallel agents cross-checked
every article against real routes/pages; findings have file:line evidence.

- **Accuracy fixes (A1+A2), ~18 articles** — re-ingested & verified live. Key
  ones: stale single fee-toggle → real **independent ACH/card pass-through
  toggles** (did NOT add "platform fee passed to tenant" — that toggle exists
  but `platformFeeAccrual.ts:30-37` shows it's not yet wired to charge
  tenants); payment-status vocab (`settled`/`processing`, not "Completed");
  notif-prefs (in-app always-on, no tenant "mark all read"); ACH setup (no
  manual entry, no auto-collection); fabricated bulk-unit creation removed;
  sales articles now lead with the **On-Time Pay guarantee**; lease "Documents"
  → **Lease** section (3 articles); landlord portal rewritten to the 6 real
  `section` values; tenant nav gained "My walkthroughs"; maintenance "choose
  your unit" removed; `$0.50` instant-payout floor; inspection "three kinds"
  softened.
- **Dedup** — deleted 6 TRUE-duplicate articles after porting each one's unique
  line into its keeper. A verification pass confirmed **no article was
  unit-type- or state-specific** (Nic's explicit concern) before any drop.
  Deleted: `tenant/how-to-pay-rent`, `tenant/finding-and-understanding-your-lease`,
  `landlord/connecting-your-bank-account-and-identity-verification`,
  `landlord/getting-paid-payouts-via-stripe-connect`,
  `landlord/how-tenant-payment-fees-and-pass-through-work`,
  `landlord/understanding-the-gam-platform-fee`.
- **Boilerplate trim** — kept the approval-threshold teaching in
  `managing-...-approval-threshold` and the risk-score teaching in
  `reviewing-screening-applications`; trimmed the repeated copies in
  `receiving-and-triaging`, `assigning-tracking-cost`, and
  `ordering-and-reading-background-checks` to brief self-contained mentions.
- **Self-healing ingest**: `ingestKnowledge.ts` now prunes orphaned chunks
  whose source file no longer exists (deletions used to strand chunks — had to
  prune by hand once; now automatic).

## How the KB gets re-ingested (operational)
Needs the embeddings server up. Start: `~/gam-start.sh models` (or
`scripts/start-embeddings.sh` → bge-large on :8081, CLS pooling). Then:
```
cd apps/api && EMBEDDINGS_ENDPOINT=http://localhost:8081/v1 \
  EMBEDDINGS_MODEL=bge-large-en-v1.5 DB_HOST=localhost DB_PORT=5432 \
  DB_NAME=gam DB_USER=postgres DB_PASSWORD=gam_dev_password \
  node -r ts-node/register src/services/agents/ingestKnowledge.ts
```
Idempotent (replaces by source, prunes orphans). Current store: **46 sources /
121 chunks** in `agent_knowledge_chunks`. Embeddings server (:8081) was left
RUNNING at end of session.

## Key decisions (Nic)
- Division of labor: **Nic organizes/decides product; Claude does ALL technical
  execution** (run commands, start services, re-ingest). Saved to memory.
- Dedup: proceed with the 6 safe drops; KEEP the DIFFERS/STAGED sets
  (payment-status pair, "what is GAM" pair, screening + maintenance clusters);
  do the boilerplate trim.
- LEAVE tenant-vs-shared scope dupes (password, notification-prefs) untouched —
  Nic wants audience-appropriate answers; revisit only with more explanation.

## Files touched (salient)
- `apps/api/src/services/bookingGuestTokens.ts` (+revoke fn)
- `apps/api/src/services/bookingGuestTokens.test.ts` (+3 tests)
- `apps/api/src/routes/units.ts` (+DELETE guest-access route, +import)
- `apps/landlord/src/pages/BookingsPage.tsx` (+GuestAccessModal, +Stay link col)
- `apps/api/src/services/agents/ingestKnowledge.ts` (+orphan-prune)
- `apps/api/src/services/agents/knowledge-content/**` — ~18 edited, 6 deleted
- `KB_AUDIT.md` (new, repo root)

## Deferred / next
- **Tenant-vs-shared scope dupes** (password/security, notification prefs) —
  not touched; available if Nic wants one-shared-vs-audience-specific.
- **Agent personas** — if Nic wants the agents to feel warmer / less monotone,
  that's `services/agents/profiles.ts` (Ava/Skye personas), not the KB.
- Carryovers from S504 (not agent-blocking): Track C video polish (thumbnail/
  duration, prod WORM/CDN, native capture), tenant-facing unit lifecycle.
- **Uncommitted tree is large**: last commit is S496; sessions 497–506 +
  the parallel S505 window are all uncommitted. Nic decides when to commit.

## Memory updated
`division-of-labor` (+ MEMORY.md index) — Nic does product, Claude does all
technical execution.
