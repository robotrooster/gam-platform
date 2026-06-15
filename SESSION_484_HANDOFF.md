# Session 484 — closed

> PM-company access to the agent_interaction_logs reporting
> surface. Closes the access-extension item from S480.

## Theme

**Agent activity is now also visible to PM-company staff,
scoped to the landlords whose properties their company
manages. Same metadata-only VIEW (`v_landlord_agent_interactions`
shipped S480), same privacy posture, same KPI shape — different
scope predicate: `landlord_id IN (SELECT DISTINCT landlord_id
FROM properties WHERE pm_company_id = :pmCompanyId)`. PM-company
portal dashboard gets a 3-tile preview card mirroring the
landlord dashboard's S482 card. Member-only access via the
existing `assertPmStaffRole` helper (owner/manager/staff), with
the suspended-company lockout carried through automatically.**

Suite (api) at S483 close: 3077 / 163.
Suite (api) at S484 close: **3084 / 164 / 0 failures** (+7
new cases + 1 new test file).

apps/api tsc: clean. apps/pm-company tsc: clean. apps/pm-company
build: clean.

## What shipped

### `apps/api/src/routes/pmAgentActivity.ts` — NEW

Mounted at `/api/pm/:pmCompanyId/agent-activity` with
`mergeParams: true` so the inner handlers can read
`req.params.pmCompanyId`.

- `GET /` — 30-day summary KPIs (totals + by_outcome +
  by_agent + by_tool).
- `GET /recent` — last N rows with optional outcome filter.

Both gate with:
```ts
await assertPmStaffRole(req.user!.userId, pmCompanyId,
  ['owner', 'manager', 'staff'])
```

which carries the suspended-company lockout (S353 — a
suspended company locks out every pm.ts surface; this one
inherits the behavior automatically by reusing the helper).

Scope predicate:
```sql
landlord_id IN (
  SELECT DISTINCT landlord_id FROM properties WHERE pm_company_id = :pmCompanyId
)
```

Landlord-audience conversations have `property_id = NULL`
(per agent-engine memory) but `landlord_id` is denormalized
on every row, so scoping by landlord catches both tenant- and
landlord-audience conversations under the PM company's
managed portfolio.

### `apps/api/src/routes/pm.ts`

`assertPmStaffRole` promoted from module-private to `export`.
No behavioral change.

### `apps/api/src/routes/pmAgentActivity.test.ts` — NEW

7 cases covering:
- **Non-staff user → 403** (random JWT, no pm_staff row).
- **Suspended PM company → staff member 403** (assertPmStaffRole
  lockout flows through).
- **Empty log → zeros** (member can view).
- **Scopes to landlords managed by THIS PM company** — seeds 2
  rows for the managed landlord + 1 row for an unrelated
  landlord, asserts only 2 show up.
- **Cross-pm-company isolation** — company A staff cannot see
  company B's rows.
- **VIEW omits verbatim user_message + agent_reply** on the
  `/recent` endpoint (same privacy assertion as S480).
- **Outcome filter on /recent**.

Inline `seedPmFixture()` builds the landlord + PM company + PM
staff + assigned property in one transaction. PM company column
name caught: `business_email` (not `contact_email`, which is on
landlords).

### `apps/api/src/index.ts`

Router mounted at `/api/pm/:pmCompanyId/agent-activity`.

### `apps/pm-company/src/pages/DashboardPage.tsx`

`<AgentActivityCard pmCompanyId={cid} />` inserted between the
"Action required" block and the "Getting started" card. Same
3-tile structure as the S482 landlord dashboard card:
- Conversations (with tenant/owner split subtitle)
- Escalated (amber when > 0, percent-of-total subtitle)
- Top agent (with conversation count)

Auto-hides on zero traffic. `enabled: !!pmCompanyId` so the
query doesn't fire before AuthContext resolves the active PM
company. `retry: false` to avoid retry storms on 403.

## Items shipped

```
apps/api/src/routes/
  pm.ts                                        (exported assertPmStaffRole)
  pmAgentActivity.ts                           (NEW — ~155 lines)
  pmAgentActivity.test.ts                      (NEW — ~200 lines, 7 cases)
apps/api/src/
  index.ts                                     (+ router import + mount)
apps/pm-company/src/pages/
  DashboardPage.tsx                            (+ AgentActivityCard component)
```

## Decisions made during build

| Question | Decision |
|---|---|
| Extend `/api/landlord/agent-activity` with PM scoping or new router | **New router under `/api/pm/:pmCompanyId/...`** matches the rest of the pm-company API convention; cleaner separation of access patterns + scope predicate; matches the way the PM portal already calls `/pm/companies/${cid}/...` endpoints. |
| Scope by landlord_id or property_id | **landlord_id.** Landlord-audience conversations have `property_id=NULL` (per memory); scoping by property would miss them. landlord_id is denormalized on every row. |
| Permission level for read | **owner + manager + staff (all active members).** No reason to gate read-only reporting to managers; the metadata-only VIEW already strips verbatim content, so even the most junior staff seeing aggregate metrics is harmless. |
| Reuse landlord page or new PM page | **Dashboard card only for now; no dedicated /agent-activity page on PM portal.** Most PM-company workflows fit on the dashboard; adding a dedicated page can land if PM staff ask for drill-down. |
| Share the AgentActivityCard component cross-portal | **No, inline duplicate.** PM-company portal lives at port 3011 with its own theme; landlord at 3001 with another. Cross-portal component sharing needs a new package. Card markup is ~80 lines; duplicate is cheaper than a package. |
| What outcome on the card → click filter behavior | **None.** The landlord page has the drill-down; PM dashboard is preview-only. If PM staff want drill-down, ship the dedicated page later. |
| Test row count | **7.** Covers 403 paths (suspended, non-member), happy path (member view, empty + nonzero), scoping (within-portfolio, cross-company isolation), privacy (VIEW omits verbatim), and filter behavior. |
| Cleanup posture | **Local `DELETE FROM agent_interaction_logs` in beforeEach.** Same as S480 — cleanupAllSchema doesn't touch the log table. |

## Verification

- `cd apps/api && npx tsc --noEmit`: clean.
- `cd apps/pm-company && npx tsc --noEmit`: clean.
- `cd apps/pm-company && npm run build`: clean (396 KB JS,
  121 KB gzipped).
- Targeted: `vitest run pmAgentActivity.test.ts` — 7 passed.
- Full: `npm test` — **3084 / 164 / 0 failures** (+7 from S483).

### Bugs caught during build

- **pm_companies column name**: initial seed used
  `contact_email`; actual column is `business_email`. Caught
  on first test run; fixed.

## Phase status

The agent-activity reporting surface is now both-portal:

| Surface | Backend | Frontend |
|---|---|---|
| Landlord | S480 (`/api/landlord/agent-activity`) | S480 page + S482 dash card |
| PM Company | **S484 (`/api/pm/:pmCompanyId/agent-activity`)** | **S484 dash card** |

Both share the metadata-only VIEW and identical KPI shape.

## What the next session should target

Remaining open items:

- **Mobile-responsiveness audit** on the new amber banners
  + KPI cards. Should reflow on phone-sized viewports.
- **PM-company dedicated /agent-activity page** with the
  same drill-down + filter UI as the landlord page. Useful
  if PM staff actually need the breakdown.
- **New product arcs** (website hosting / listings build-out
  / property-intel build-out) — needs direction.

No strong single recommend. The state-law + agent-activity
arcs are now structurally complete across all three portals
(landlord, tenant, PM company) where they belong.

---

End of S484 handoff. **PM-company agent-activity access
shipped: backend router + dashboard card. Same VIEW, scoped
by managed landlord portfolio, member-only.**

3084 tests / 164 files / 0 failures.

**Agent-activity reporting surface now structurally complete.**
