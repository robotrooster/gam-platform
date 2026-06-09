# Session 232 — closed

## Theme

S113 closeout audit. The `DEFERRED.md` "Stripe Connect S113 rebuild"
multi-session epic was the single biggest gating item on the build
queue, blocking 4+ other items and weighting the
"sessions-to-complete" estimate by ~10. Recon found the rebuild had
been progressing across many sessions and is fully shipped — all 5
phases plus Phase A safety valve. This session updated DEFERRED to
reflect actual code state.

## Recon finding (the big one)

The S113 epic is in tree end-to-end:

| Phase | Status | Code |
|---|---|---|
| A — passthrough/landlord-reconcile | ✅ | `services/landlordPassthrough.ts` (165L) — auto-reconciles `payments.platform_held` rent collected while Connect was incomplete. Fired from `recordAccountUpdated` when account flips ready. |
| 1 — manager fee Stripe transfers | ✅ | `services/stripeConnect.ts:fireManagerTransfersForReference` + `jobs/managerTransferReconciliation.ts` daily reconciliation cron. |
| 2 — finances current_balance from Connect | ✅ | `routes/finances.ts` reads from `getAvailableUsdBalance(connectAccountId)` instead of GAM-book ledger sum. |
| 3 — Payouts engine | ✅ | `services/connectPayouts.ts` (131L) — `firePayoutForConnectAccount` with idempotency-key required, `getConnectBalance` / `getAvailableUsdBalance` / `getInstantAvailableUsdBalance`. |
| 4 — Auto-Friday cron | ✅ | `jobs/autoPayouts.ts` + scheduler at `scheduler.ts:589-599` (Mon-Fri 9am Phoenix tick, engine self-gates to actual Friday/holiday-shift day). |
| 5 — On-demand withdrawals | ✅ | `routes/withdrawals.ts` (`/api/users/me/withdrawals/preview` + `/api/users/me/withdrawals` POST) — standard + instant payouts gated by Connect balance. |

Surrounding infra also done:

- `users.stripe_connect_account_id` + `users.connect_charges_enabled` /
  `connect_payouts_enabled` / `connect_details_submitted` columns
  with unique-not-null index + `idx_users_connect_ready` partial.
  Same shape on `pm_companies`.
- `connect_payouts` and `connect_disputes` tables with idempotency on
  `stripe_payout_id` / `stripe_dispute_id`.
- Webhook handler at `routes/webhooks.ts:465-538` — covers
  `payout.created` / `.paid` / `.failed` / `.canceled` →
  `recordPayoutEvent`; `charge.dispute.created` / `.updated` /
  `.closed` → `recordDisputeEvent`; `account.updated` →
  `recordAccountUpdated` (also propagates payout status to
  `disbursements.status` audit rows + notifies recipient).
- Embedded onboarding (`<ConnectAccountOnboarding />` via
  `loadConnectAndInitialize` + Account Sessions) at
  `BankingPage.tsx:342-449`. Manager-only branch at
  `BankingPage.tsx:76-92` for managers landed on `/banking` after
  the landlord enabled their direct-deposit toggle.
- `routes/payments.ts:299-313` — rent flow actually fires
  `createRentDestinationCharge` when destination Connect is
  charges_enabled, falls back to `createRentPlatformCharge` when
  not (with `payments.platform_held=true` + later auto-reconcile).
- `services/stripeConnect.ts:firePmTransfersForReference` /
  `fireManagerTransfersForReference` — both use `source_transaction`
  pointing at the original charge to fund the transfer from the
  destination Connect's settlement, not GAM's platform balance.

Pre-S113 outbound rail (item 16 batch 2) was superseded; the prior
`disbursementFiring.ts` was removed at S199.

## What S232 shipped — DEFERRED.md updates

### Tombstoned

The "Blocked / multi-session" entry for the S113 rebuild deleted
from line 104-114; new closed-tombstone added under "Closed —
major-item tombstones" with the per-phase landing summary and
file:line cross-references for future audits.

### Unblocked → moved to "Open"

- **utility_bills payment integration**: removed "Defer until
  Stripe Connect bank rail (S113) lands" — replaced with concrete
  guidance pointing at `createRentDestinationCharge` as the firing
  target. Still has an open product question (separate PI per
  cycle vs. add-on to next rent pull) — that part stands.
- **Landlord disbursement engine for deposit interest netting**:
  removed "Blocked on Stripe Connect S113 rebuild" — replaced
  with concrete guidance pointing at `services/connectPayouts.ts`.

### Stale entries corrected

- **Stripe Terminal POS integration**: the prior "S81 gated, but
  the create-PI → capture → record-tx flow is one hop from real"
  was misleading — `terminal.ts` doesn't exist; nothing is "one
  hop." Replaced with accurate greenfield description (schema +
  reader pairing + Connection Token endpoint + capture flow all
  need building). Folded the prior "POS Terminal hardware
  (depends on hardware adapter selection)" blocked entry into
  this one as the gating note, removing the duplicate.
- **OTP enablement**: prior wording "scaffolding... will throw if
  the scheduler ever fires" + "currently disabled" was stale.
  `otpScheduler.ts` doesn't exist; `services/otp.ts` does and is
  feature-flag gated via `system_features.otp_rollout_visible`
  (cleanly returns short-circuit when off, no throw).
  Cron at `scheduler.ts:782` runs daily and short-circuits on the
  flag. Updated entry to reflect actual remaining work: full UI
  surface, advance-from-reserve disbursement (the real outstanding
  TODO at `scheduler.ts:901`), and end-to-end qualification gate
  confirmation (bg → deposit → ACH → enroll).
- **Owner/manager allocation tombstone**: removed "Step 4 Stripe
  firing pending under S113" — Step 4 fired via S113-Phase1 +
  Phase 4. Updated to reference the S113 closeout tombstone.

### Files touched (S232)

```
DEFERRED.md   (S113 epic tombstoned + 4 stale entries corrected)
SESSION_232_HANDOFF.md   (new)
```

No code changes. No migrations.

## Decisions made (S232)

| Question | Decision |
|---|---|
| Tombstone S113 cleanly vs. leave as in-progress with phase counts? | Clean tombstone. All 5 phases + Phase A are in tree with file:line cross-refs. The session-history is recoverable via grep on `S113-Phase` markers in code (5 phases turned up across 5 files); no need for DEFERRED to re-narrate. |
| Move "blocked on S113" items to Open queue or keep them flagged? | Move to Open. The S113 unblocking is durable — destination charges are live in production code at `payments.ts:299`. Marking these "still blocked" would mislead future-Claude into avoiding them. |
| Audit-first vs. tombstone-first? | Audit first. Tombstoning without verifying could have left a real gap unnoticed (e.g. if Phase 5 had been stubbed). Reading each phase's actual code took ~20 min and surfaced the corrections to the OTP / Terminal / allocation entries that wouldn't have been caught otherwise. |
| Update CLAUDE.md "Architectural decisions" section now or later? | Later. CLAUDE.md's S113 section is forward-looking (architecture locked, build order to come) and accurate as a *spec*. Once we're closer to v1 launch a clean rewrite of the Stripe section makes sense; mid-flight rewrites cost more than they help. |
| Touch the `S29c-2-A` / `S29c-2-F` legacy session-handoff files? | No. Those are historical record. The current state lives in DEFERRED + recent handoffs. |

## Carry-forward — S233+

### Newly-pickable now (post-S113 closeout)

These were "blocked on S113" until this session and are now on the
queue:

- **utility_bills payment integration** — backend wiring, ~1
  session. Outstanding question: Nic product call on whether
  utility_bills rolls into the next rent PI as an add-on
  (single charge) or fires its own scheduled PI (separate cycle).
- **Deposit-interest monthly-payout netting** — engine work
  layered on top of the existing `connectPayouts.ts` firing.
  Fairly self-contained; ~1 session.

### Outstanding from earlier sessions (unchanged)

See `DEFERRED.md` "Open — pick one" section. The queue is now:
- 3 backend/data items (1 Nic-blocked, 2 newly pickable from above)
- 5 POS items (1 Nic-blocked on stacking semantics, 2 hardware-
  adapter-deferred, 1 smoke, 1 multi-terminal)
- 1 e-sign UI bundle (UI/UX backend-complete batch)
- 1 background-check follow-up (Checkr-blocked)
- 4 smaller items
- 2 harness extension items

### Revised count to GAM-complete

(updates the count from earlier in the session)

| Bucket | Count | Sessions |
|---|---|---|
| Pickable now | ~12 | ~12 (was ~10 before S113 unblock) |
| Nic-blocked product calls | ~5 | gated on his decisions |
| External-vendor-blocked (Checkr) | 1 | 1 once approved |
| Multi-session epics still pending | 3 | Flex Suite (~3-5), Sublease (~3+), F1 Marketing rebuild (~2-3) |
| npm audit upgrades | 4 | 4 |
| Pre-launch flag-gated build | 2 | OTP UI surface + reserve-disbursement, tenant-pool refinements |

**Until v1 launch-ready (no Flex/Sublease):** ~15 sessions.
**Until 100% feature-complete:** ~25 sessions.

The S113 closeout doesn't shorten the totals from the prior message
— it confirms them. The shape is clearer: there's no longer a
single 8-15 session monster epic looming. The remaining work is
batched into ~1-session items + a handful of 2-5 session epics
(Flex / Sublease / Marketing rebuild) that can be tackled in any
order.

---

End of S232 handoff.
