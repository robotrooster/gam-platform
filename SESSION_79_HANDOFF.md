# Session 79 Handoff

**Theme:** Item 8 / part 1 — sub-permission catalog. Single small batch.
Architecture clarification was the bulk of the session; the actual code
delta is one file in shared.

## Context

Started S79 framing Item 8 as "Team UI rebuild." Recon revealed:

1. **Architecture is layered**, not single-model. Role + per-role scope
   table (which properties/units) + sub-permissions (which features
   within the role) coexist.
2. **Per-role *_scopes tables already exist** (S62 era):
   `property_manager_scopes`, `onsite_manager_scopes`,
   `maintenance_worker_scopes`, `bookkeeper_scopes`. Shapes match Nic's
   role descriptions exactly:
   - PM: multi-property, traditional company setup
   - Onsite: anchored to property/unit (motel desk, RV park)
   - Maintenance: dispatch-friendly (allProperties bool, jobCategories)
   - Bookkeeper: org-wide accessLevel
3. **Full invitations workflow exists** in `routes/scopes.ts` —
   token, expires, scope_payload, accept handler that creates *_scopes
   row and the user account.
4. **What's missing:** sub-permissions concept. ROLE_PERMISSIONS in
   shared is hardcoded per role and dead (zero readers). Today, role
   determines feature access; nothing finer.
5. **Dead code surfaced:** `routes/team.ts` (pre-S62 references phantom
   `team_property_access` and missing `team_members.invite_email/_token`
   cols), `apps/landlord/src/pages/TeamPage.tsx` (38-line stub).

## Shipped

`packages/shared/src/index.ts` — added per-role sub-permission catalogs:

- `PROPERTY_MANAGER_SUB_PERMISSIONS` (19 keys: team / properties / units /
  tenants / leases / payments / maintenance approval / books)
- `ONSITE_MANAGER_SUB_PERMISSIONS` (9 keys: POS ring/refund/void/discount/
  EOD/inventory + guest check-in/out + unit status)
- `MAINTENANCE_SUB_PERMISSIONS` (7 keys: work orders / purchases /
  unit access / time tracking)
- `SUB_PERMISSIONS_BY_ROLE` map keyed on role (excluding bookkeeper)
- `SUB_PERMISSION_LABEL` map for display strings
- TypeScript types: `PropertyManagerSubPermission`, etc., `AnySubPermission`

Bookkeeper intentionally absent — single `accessLevel` (read_only |
read_write) on bookkeeper_scopes is the right granularity for that role
per Nic's call.

Comment block at top of catalog records: storage target
(`team_members.permissions` jsonb), follow-up dependencies, and that
route gating is NOT yet wired.

## What this session did NOT do (deferred to follow-up)

- **Storage plumbing** — invitation accept flow doesn't currently write a
  `team_members` row. Decision needed: dual-write team_members vs move
  `permissions` jsonb onto each *_scopes table and rip team_members.
- **TeamPage UI** — still a 38-line stub. Needs unified read across 4
  scope tables + invitations + permissions toggle UI per member.
- **Route gates** — every route currently gating on role only (POS
  refund, maintenance approve, etc.) needs per-route audit + check
  against the permissions jsonb. Per-route work, separate session.
- **Rip routes/team.ts** — pre-S62 dead code; strip when storage decision
  lands.

All four tracked under DEFERRED.md item 8 sub-tasks 8a–8d.

## Files touched

- packages/shared/src/index.ts (catalog added)
- DEFERRED.md (item 8 expanded into 8a–8d sub-tasks with progress notes)
- SESSION_79_HANDOFF.md (this file)

## Validation

- `cd packages/shared && npm run build` → exit 0
- `cd apps/api && npx tsc --noEmit` → exit 0

## Pre-launch blockers still open

- Item 8a/8b/8c/8d — see DEFERRED.md (storage decision, TeamPage UI,
  route gates, dead-code rip).
- Item 16 batch 2 — bank ACH origination provider selection + real call.
- Item 16 batch 3+ — applicant bg check payment, OTP enablement, pool
  unlock $1, mock pi_* replacement.
- Item 2 — FCRA adverse action notice infrastructure.
- Item 10 — Utility billing subsystem (multi-day).
- Item 11 — Master Schedule finish-or-strip (needs Nic's product call).
- Item 14 — POS app completion (multi-day).
- Item 15 — E-sign frontend visual + e2e smoke.
- Item 19 — Email systems consolidation.

## What next session should target

Top picks for S80:

1. **Item 8a — Storage decision + plumbing.** Pre-req for 8b. Pick:
   dual-write team_members on accept, or move permissions onto each
   *_scopes table. Recommend the latter (single source per role; rip
   team_members; auth.ts /login query simplifies to look up the
   scope-table-of-record for the user's role).
2. **Item 19 — Email consolidation** — Resend vs nodemailer cleanup with
   nodemailer audit blockers. Bigger blast radius.
3. **Item 16 batch 3** — applicant bg check payment via Stripe
   PaymentIntent. Rail-independent of batch 2.

Recommend **8a** — keeps Item 8 momentum and unblocks 8b TeamPage UI.
