# Folding the PM portal into the landlord portal

**Decided 10/22 (Nic).** The third-party property-management portal
(`apps/pm-company`, pm.goldassetmanagement.com) stops being its own app. A
management company becomes what it always was in GAM's own model: an entity
sitting outside the account, with people who hold access to it.

> "Blue's going to be property managing for some other people. And he doesn't
> necessarily want to toggle between portals with a different login. He wants to
> just adjust a view in the same screen."
>
> "The goal is flexibility to allow them to run the business where they want to
> run it. All these other softwares I've used in the past, I have to come up
> with some ghetto workaround to get it to do what I want."

Nobody is on the PM portal: **2 pm_companies, 0 pm_staff, 0 properties with a
pm_company_id.** Deciding now costs nothing; waiting means migrating real
accounts later and widening the feature gap in the meantime.

## Why it is safe — the architecture is already there

The hard part was built for Nic's own two LLCs:

| Already true | Where |
|---|---|
| Companies sit OUTSIDE the account | `landlord_members` (10 rows), `gam-account-is-not-an-entity` |
| An account can act for several companies | `landlordScopeIds` / `isEntityMember` |
| Nothing is ever a default company | `resolveLandlordTarget`, `EntityPicker`, S654 |
| Every money page filters by company | S652 sweep |
| Per-person permissions, per property | `PERMISSION_CATALOG`, `PERMISSION_PRESETS`, the four scope tables |
| Connect/payouts are per ENTITY | `gam-connect-per-entity` |
| A management LLC can already be an entity | Blu created "TruBlu Management LLC" |

A PM managing for five owners is the same shape as one account owning five
companies. The difference is only HOW the access was granted.

## The two real blockers

1. **`landlord_members.role` has `CHECK (role = 'owner')`.** There is no way to
   say "this account may act for that company because it MANAGES it."
2. **One scope row per user.** `assertPropertyInScope` and
   `getScopedPropertyIds` read
   `SELECT ... FROM <scope table> WHERE user_id = $1 LIMIT 1`, and a team token
   carries a single `landlordId` claim. A manager working for two owners gets
   one owner's properties and silently loses the other — or, if the wrong row
   has `all_properties`, sees more than they were given.

Everything else in the fold is pages and data.

## Nothing is lost — the inventory

Thirteen pages, 4,263 lines, 30 endpoints.

| PM portal page | Where it goes |
|---|---|
| Dashboard | Landlord dashboard, company filter = the management company |
| Properties (across owners) | Properties page; the roll-up is `ownerPortfolio(landlordIds)` |
| Property detail / drilldown | Landlord property pages (richer already) |
| **Owners** + per-owner statements | NEW section: Management → Owners |
| Invitations (PM side) | Landlord `PmInvitationsPage` already mirrors it |
| **Fee plans** | NEW: Management → Fee plans |
| **Staff** | Team page, with sub-delegation (below) |
| **Banking / Connect KYC** | Banking page, per entity (already per-entity) |
| Settings | Settings, per entity |
| Agent activity | Landlord `AgentActivityPage` already exists |
| Login / password recovery / 2FA | The landlord portal's own |
| Register (new PM company) | Add-entity flow, marked as a management company |

Tables stay exactly as they are: `pm_companies`, `pm_staff`, `pm_fee_plans`,
`pm_invitations`, `pm_property_invitations`, `pm_monthly_fee_accruals`,
`properties.pm_company_id`, `properties.pm_fee_plan_id`. The allocation engine's
PM fee cut (`allocation_pm_company_fee`) is untouched.

## What a third-party PM would STILL be missing, and is being added

1. **Sub-delegation.** A PM owner adds their own maintenance tech / front desk
   and grants permissions, exactly as an owner does in-house — Nic: "It's the
   same kind of breakdown as the people that do it on site." **Hard cap: a PM
   staffer's access can never exceed what the owner granted the PM company**
   (property set AND permission set).
2. **Several companies on one login**, with no default, and a switcher that
   starts on "Choose a company…" at two or more.
3. **Owners layer** — the PM's list of owners and each owner's statement, and
   the owner's own view of what their PM did (part of the 11k-unit PM ask).
4. **A guard test** that every landlord-portal route either narrows by the
   caller's scope or is named as deliberately company-wide — the same shape as
   the action-gap and determinism guards. This is what makes folding safe
   instead of hopeful: today only 15 of 108 route files call a scope check by
   hand.

## Order — ALL SIX DONE (10/23)

1. ✅ `landlord_members.role` takes `'manager'`, with `via_pm_company_id` so the
   access belongs to the company the owner engaged.
2. ✅ Scope AND permissions resolve per company. The `LIMIT 1` reads are gone;
   a property names its company and that company's grant decides. A
   landlord-role user who MANAGES a company no longer bypasses the property
   check on it — that was the hole the fold would have opened.
3. ✅ Sub-delegation: accepting an engagement grants the company's people that
   property, with the permissions their own boss gave them, **capped by what the
   owner agreed to** (a `view` engagement can change nothing, ever).
   `services/managedAccess.ts`.
4. ✅ Two guards: nothing reads a scope row by person alone
   (`scopeReadsAreCompanyAware`), and no new landlord-side route mutates without
   a property gate, a company gate or a stated reason
   (`landlordRoutesAreScoped` — a ratchet over a dated debt list).
5. ✅ One **Management** section in the landlord portal — owners and their
   monthly statements, engagements, rate sheets, staff, banking — calling the
   same `/pm/companies/...` endpoints the old portal did. The company picker
   groups "Companies you own" and "Companies you manage for others".
6. ✅ `pm.goldassetmanagement.com` is a one-page door that says where things
   moved and forwards to the landlord portal (works with JavaScript off). The
   thirteen pages are deleted; its test stage is gone from `deploy.sh`; the
   surface still builds so the subdomain keeps answering a bookmark.

**Still worth doing, and not part of the fold:** the eleven route files marked
`TO VERIFY` in `landlordRoutesAreScoped` — read each and either scope it or say
what gates it. And `maintenance-portal` wants a property gate once a management
company has maintenance staff.

## Guards that must hold throughout

- No default company, ever (S654). One company is resolution, not a default.
- A PM staffer never sees a property the owner did not grant the PM company.
- A PM staffer never sees the owner's other companies.
- Audience isolation: landlord / tenant / platform each see only their own.
- Connect accounts stay per entity; the PM's fee cut keeps routing as it does.
