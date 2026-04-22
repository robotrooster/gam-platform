# Session 23d-infra handoff — April 22, 2026

## What landed this session

- 23505 race translation in `POST /api/scopes/:roleType/invite`: the `invitations_unique_pending` partial unique index now returns a clean 409 instead of a 500 when two concurrent invites for the same (landlord, role, email) collide. Constraint-name-scoped so other unique violations still surface as 500 correctly. TSC baseline held at 16.
- Migration file `migrations/001_s23d_invitations_scopes.sql` captures the full DDL for invitations, platform_events, and the four role scope tables. Prior to this, the schema only existed in the local Postgres — nothing was versioned. This file is now the source of truth for that schema.
- Commit landed covering the entire S23d-infra body of work (sessions A, B, C, D). This is the first commit of any of that work — previous sessions deferred commits and none actually landed.

## The pivot — why UI did not ship

Began the landlord Team UI. Got as far as writing TeamPage.tsx (tabs + person rows + pending/audit sections). Stopped before wiring the invite modals after Nic clarified the real model:

**Role is a label. Every permission is an independent toggle the landlord flips per team member.**

Landlord assigns a role label (property_manager, onsite_manager, maintenance, bookkeeper) so the person has an identity and the portal knows how to route them. But actual access is 100% permission-flag-driven — can_see_leases, can_approve_maintenance, can_show_units, maint_approval_ceiling_cents, property_ids_scope, unit_ids_scope, etc. Landlord toggles any permission on any team member regardless of their role label. Onsite manager who the landlord promotes to handle leases? Just flip `can_manage_leases` to true. Done.

This does not fit the four-separate-scope-tables backend that S23d-infra shipped. Per-role tables force permissions to be structured by role. The right shape is one `team_member_scopes` table with a full permission flag matrix and a `role_label` column.

## Next session — backend rebuild (before any UI)

Scope of the rebuild session:

1. **New table `team_member_scopes`** — one row per (user_id, landlord_id) pair. Columns: role_label (text, CHECK against the four LANDLORD_ASSIGNABLE_ROLES), plus every permission flag as its own boolean or structured column. Proposed matrix for Nic to review before the migration runs:
   - Scoping: `all_properties` boolean, `property_ids` uuid[], `unit_ids` uuid[]
   - Leasing: `can_view_leases`, `can_manage_leases`, `can_sign_leases_for_landlord`
   - Showings: `can_show_units`, `can_screen_applicants`
   - Maintenance: `can_view_maintenance`, `can_approve_maintenance`, `maint_approval_ceiling_cents` (nullable), `job_categories` text[] (existing CHECK)
   - Financial: `bookkeeper_access_level` (read_only | read_write | null), `can_view_disbursements`, `can_view_reports`
   - POS: `can_operate_pos`, `can_manage_inventory` — plugs into Nic's planned POS team integration
   - Tenants: `can_view_tenants`, `can_message_tenants`
   - Team: `can_invite_team_members` (PM-style delegation)
2. **Migration strategy** — new migration file that creates team_member_scopes, backfills from the four existing scope tables with conservative defaults derived from the current role, flags the four old tables as deprecated (rename to `_deprecated_<table>` or keep and stop writing). Do not drop until a later cleanup session.
3. **Shared package** — replace the four role-specific ScopePayload types with a single TeamMemberScopePayload reflecting the flag matrix. Keep LANDLORD_ASSIGNABLE_ROLES as role labels.
4. **Rewrite `apps/api/src/routes/scopes.ts`** — single table, single zod schema, simpler invite flow (no per-role branching), simpler accept flow.
5. **Invitation schema change** — `invitations.scope_payload` shape changes to the new flag matrix. Existing rows: purge pending/expired/revoked; accepted rows are historical audit only, leave alone.
6. **Relax the accept-flow role rejection** — an existing user accepting a second invite from a different landlord (or the same landlord with a different role label) should add a team_member_scopes row, not 4xx.
7. **Middleware** — replace requirePropertyManager / requireOnsiteManager / etc. with `requirePermission(flag_name)`. Existing `requireLandlord`, `requireAdmin`, `requireTenant` untouched.
8. **Onsite uniqueness revisit** — current onsite_manager_scopes has UNIQUE(user_id) platform-wide, contradicting Nic's "one person can work for multiple landlords" rule. Drop that constraint in the new model.

Session after backend rebuild: Team UI. Tabs filter by role_label, each row shows the person plus a permission panel the landlord toggles.

## Still deferred (unchanged from prior handoffs)

- Properties endpoint `$9` placeholder audit.
- GAM Books AZ-specific tax logic genericization.
- Master Schedule finish-or-strip.
- ReportsPage endpoint build.
- TSC rot — 16 errors at baseline since S19. `background.ts` vision typed unknown, `fitness.ts` AuthRequest mismatch, `units.ts:403` .id on AuthPayload. Boot tolerant via tsx.
- S23c original-lease smoke walk — still deferred per Nic.
- Permission gating audit across landlord portal — blocked on Team UI shipping so there is something to test with.
- PM subsystem removed (pm.ts deleted) — no rebuild scheduled.

## Housekeeping finding

Prior to this session, every handoff claimed "22-25 unpushed commits" on feature/gam-books. Actual state was 5 unpushed commits (all S23c) plus a working tree mountain of uncommitted S23d-infra work. Sessions A/B/C/D each said they committed nothing, and that was literally true. Today corrects that — feature/gam-books now includes the full S23d body of work as one commit. After pushing, branch will be 6 ahead of origin.

## Standing rules unchanged

Commandment 16: single source of truth. No state-specific legal logic. No third-party AI on tenant data. Recon before writing. Single-quoted heredocs. One targeted fix confirmed before the next. Call context at ~50%. No emojis unless Nic uses them first.
