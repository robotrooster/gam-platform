Session 60 Handoff — DEFERRED.md created, money-flow architecture locked

Date: May 1, 2026

WHAT SHIPPED

No code, no migrations. This was a planning session. Three artifacts on disk:

1. DEFERRED.md (385 lines) at repo root. New canonical to-do list. Replaces
   the inline deferred list in handoffs going forward. S-handoffs reference
   this instead of re-listing every item.

2. CLAUDE_RULES.md at repo root. New file holding standing engineering rules
   accumulated across sessions. S60-1 added: recon commands must be reliable
   on the first run (use `;` not `&&`, don't rely on \\d output that
   truncates, mark empty greps with explanatory text).

3. Updates to DEFERRED.md across the session as scope decisions landed.

RECONCILE WORK

Reconciled S59 deferred list against harness output (27 missing tables,
28 missing columns across 6 tables, 1 anti-pattern ack, exit 1).

26 of 27 phantom tables map cleanly to existing deferred items (POS *13,
maintenance *5, work_trade *3, flex_charge *2, plus single phantoms for
admin_action_log, notification_preferences, team_property_access).

1 NEW phantom table surfaced: books_access. 6 refs in books.ts (lines 590,
611, 646, 667, 684), no schema_migrations row, no .sql file mentions it
anywhere. S12-15 history claimed it was built but it never landed. Added
to Books rebuild scope.

28 missing columns all map cleanly to existing items.

3 STALE items struck from S59 deferred:
- properties.amenities — no code refs anywhere, never a real drift
- properties PATCH $9 placeholder bug — both hits are legitimate end-of-
  sequence numbered placeholders ($1..$9 line 52, $1..$12 line 297)
- "phantom employees table at books.ts:193" — S59 misread. Code writes to
  books_employees which exists in DB. The az_withholding_pct rename for
  that table is real and lives under Books rebuild.

S59 counting error fixed: Master Schedule is 3 units cols + 6 unit_bookings
cols = 9 total, not "8 + 1". Items unchanged, count was wrong.

ARCHITECTURE DECISIONS LOCKED

The session shifted partway through from list-cleanup into a series of
foundational architecture decisions. All recorded in DEFERRED.md.

Books rebuild scope (item 3): one combined session, build order:
  Foundation: bookkeeper-access (Option C — landlords get auto-access to
  their own books with their landlord login; outside bookkeepers get
  independent accounts and are invited in by landlord. books_access is
  the invite/permission record.)
  State-tax genericize: rename az_withholding_pct → state_withholding_pct,
  strip AZ-prefix UI labels (8 sites in apps/books/src/main.tsx), strip
  hardcoded AZ A1-QRT/AZ A1-R from Tax Center deadlines, build configurable
  per-state rate + state_forms table + landlord UI.
  Bug fixes: 5 broken bookkeeper endpoints.

PM subsystem (item 13): SUPERSEDED by 16a. PM is not a separate entity
type. No pm_companies, no pm_fee_plans, no landlords.pm_company_id, no
landlords.pm_fee_plan_id. A "PM company" is just a user whose account is
set as properties.managed_by_user_id on properties owned by other users.
Cleanup remaining: delete pm.ts.s20backup.

Money-flow architecture (item 16a, NEW): platform-mediated. All money
through GAM.

User model: one user concept. No landlord-vs-PM role flag.

Property pointers:
  properties.owner_user_id (who owns it)
  properties.managed_by_user_id (who deals with it; defaults to owner)
  Owner has read-only access to finances on properties they own. No
  notification spam. Notifications and to-dos route to managed_by only.

Allocation rule per property — flexible, supports any combination:
  % of rent collected, flat monthly fee, % with floor/ceiling, per-unit
  fee, leasing/placement fee, maintenance markup. Multiple PM companies
  use different methods, schema needs to hold any combination.

Balance ledger: per-user running balance ledger. Same shape as existing
reserve_fund_ledger pattern (type, amount, balance_after, reference_id,
notes) but with user_id and one ledger per user instead of one global.
Credits when allocations land, debits on withdrawal. Single source of
truth for "what does GAM owe whom."

Payout cadence (no tiers, no subscriptions, two paths only):
  Auto: every Friday. Holiday → following Monday. FREE to landlord. GAM
  absorbs the per-transaction fee on the weekly batch as predictable
  margin cost.
  Manual on-demand: any day, user-initiated each time. CHARGES the landlord
  a fee (covers per-transaction cost + GAM margin). Pricing TBD. Margin
  lever — minimizing per-transaction outbound fees by batching is the
  reason weekly is the default.

Existing scaffolding under 16a:
  KEEP: payments.ts OTP/reserve fund logic (separate concern)
  KEEP: reserve_fund_ledger pattern (right shape, reuse for per-user)
  RESHAPE: disbursements table — currently single-payee (one landlord_id,
  one amount). Becomes "external withdrawal from a user's GAM balance to
  their bank." Add user_id, trigger_type ('auto_friday'|'manual_on_demand'),
  fee_charged. Free to redesign — table has 0 rows, nothing depends on
  current shape.
  DELETE: disbursements.ts (20-line empty stub, no handlers).

POS confirmed launch-tier (item 14): required for RV parks. Concrete use
cases: propane refills, dump-station fees, walk-up amenity sales. Build
needs non-tenant transaction support, not just tenant-account charges.

Utility billing locked as launch-tier with quality bar (item 10):
mandatory full happy-path smoke (meter read → bill generation → tenant
view → payment received) before considered done. Differentiator — most
competing softwares lack or fail to deliver utility billing reliably.

Stripe pricing pending (item 16): Nic waiting on Stripe to confirm partner
rates. Build can proceed with standard rates as placeholder, swap when
real numbers arrive.

CROSS-CUTTING EFFECTS noted in 16a:
  Item 7 (notifications rebuild): routing reads managed_by_user_id, not
  landlord_id.
  Item 8 (team UI rebuild): re-examine — team scopes might be redundant
  vs managed_by, or still needed for sub-users under a manager.
  Item 17 (permission gating audit): owner read access vs manager action
  access becomes the central rule.
  Dashboard to-do endpoint: same shape, different filter — todos for
  properties where logged-in user is managed_by, not owner.

NEW STANDING RULES

S60-1 (in CLAUDE_RULES.md): Recon commands must be reliable on the first
run. Use `;` not `&&` between sections. Don't use \\d for output that will
be pasted back — use pg_get_constraintdef and information_schema queries
instead. Mark empty greps with explanatory text. One recon paste should
answer the recon question. Failure mode tonight: at least two re-runs
needed because of broken `&&` chains and \\d truncation.

S60-2 (informal — not yet written): when user states a rule in one
message, hold it across subsequent messages. Don't treat each new
message as the latest source of truth that overwrites earlier rules.
Failure mode tonight: forgot the "outbound transfers eat margin → on-
demand must cost the landlord" rule one message after Nic stated it.
Same shape as S59-1 — fixating on mechanism while losing the principle.
Worth promoting to written rule next session.

S60-3 (informal): Nic doesn't write code. Copy-paste in terminal only.
This was the user's number-one stated rule and was broken on the first
turn of the session. Never present partial commands, never say "run X
and see what happens," always give complete copy-paste-able blocks.

NUMBERING

S60 was the 60th chat. Session count = chat count. Next is S61. Clean
increment.

CONTEXT NOTE

Wrapped at roughly 50% context per the standing handoff rule. Did not
open the permission gating audit (item 17) because that recon would
produce significant output and is better done in a fresh session.

NEXT SESSION CANDIDATES

By foundation-first ordering with Stripe pricing pending:

1. Permission gating audit (item 17). Pure recon. No decisions needed
   from Nic. Read every route, list which have role checks, which have
   scope filters, which have neither. Output is an inventory that informs
   how to size the actual fix work. This unblocks Books bookkeeper-
   access (item 3 foundation) and the 16a managed_by enforcement.

2. Email systems consolidation (item 19). Pick one sender (Resend
   probably, since it's already in services/email.ts and used by the
   background-check work shipped in S59), retire the other, deal with
   the npm audit blockers on nodemailer. Then every email path uses one
   code path. Books invite, adverse-action notice, background-check
   decision all sit on top.

3. 16a Phase 1: schema only. Not the full subsystem build. Just the
   schema migrations — properties.owner_user_id + managed_by_user_id,
   allocation rule storage, per-user ledger table, reshape disbursements.
   Foundation only. Allocation execution and payout job come in later
   sessions on top of clean schema.

End of S60 handoff.
