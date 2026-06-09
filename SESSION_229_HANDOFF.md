# Session 229 — closed

## Theme

Landlord-portal team invite UI. The DEFERRED entry "Frontend
bookkeeper invite UI" turned out to mask a broader gap discovered
in recon — `TeamPage.tsx` had no invite form at all for any role,
not just bookkeeper. Built one form covering all 4 assignable roles
and routed it to the canonical S80 token-based scopes invitation
endpoint.

## Recon finding

The pre-S229 state of team invitation surfacing:

- **Backend `POST /api/scopes/:roleType/invite` has been live since
  S80** — token-based, sends an email with an accept link, validates
  per-role scope payload, blocks duplicate pending invites.
- **Frontend `TeamPage.tsx`** showed the team-member roster + pending
  invitations list, but had **no UI to actually create an invitation**
  for any role.
- **The books portal `/clients` page** had a separate invite form for
  bookkeepers that calls `POST /api/books/bookkeeper/invite` (the
  direct-create variant — landlord sets a password, no email link).
  That stays — it's a books-portal convenience.

So the real gap was bigger than the DEFERRED entry implied: the
landlord-portal TeamPage was the natural home for invitations of all
four assignable roles (PM / onsite manager / maintenance / bookkeeper)
and didn't have one.

## What S229 shipped

### Frontend — `apps/landlord/src/pages/TeamPage.tsx`

New `InviteForm` component, mounted at the top of TeamPage between
the page header and the (loading-conditional) members table.

Form fields:
- **Email** (required, `type="email"`)
- **Role** select — populated from `LANDLORD_ASSIGNABLE_ROLES`
  (PM / Onsite Manager / Maintenance / Bookkeeper), labeled via
  `LANDLORD_ASSIGNABLE_ROLE_LABEL`
- **All-properties toggle** — shown only for PM / onsite / maintenance.
  Off by default; landlord can refine per-property after acceptance
  via the existing TeamPage rows.
- **Job categories chip-multiselect** — shown only for maintenance.
  Empty by default (= all categories per the backend default).
- **Access level select** — shown only for bookkeeper. Defaults to
  `read_only`; the alternative is `read_write`. Inline label clarifies
  the difference.

Submit handler:
- Builds the per-role `scope` payload matching the four zod schemas
  in `scopes.ts:30-52` (`pmScopeSchema` / `osScopeSchema` /
  `mwScopeSchema` / `bkScopeSchema`).
- POSTs to `/scopes/${role}/invite`.
- On success: invalidates `'team'` query (so the new pending invite
  appears in the existing invitations table below the form), clears
  the form, shows a green inline confirmation that auto-dismisses
  after 4s.
- On error: surfaces the API's message inline (handles the 409s the
  backend returns for duplicate pending invites and onsite-manager
  uniqueness violations).

### Files touched (S229)

```
apps/landlord/src/pages/TeamPage.tsx        (+ apiPost import, + 4 shared imports, + InviteForm component, + form mount in render)
```

### Verification

- `cd apps/landlord && npx tsc --noEmit` → clean.
- No backend changes — wires entirely to the S80 endpoint and its
  existing zod validation + email delivery.
- No new migrations.

## Decisions made (S229)

| Question | Decision |
|---|---|
| Build the form on TeamPage covering all roles, or only fix bookkeeper-from-books-portal? | TeamPage covering all roles. The wider gap was that landlords had no in-portal invite path for ANY role; building bookkeeper-only would have left the same inconsistency in place for PM / onsite / maintenance. |
| Property/unit pickers in the invite form, or refine after acceptance? | Refine after. Picking specific properties at invite time would have made the form heavy (3 × dropdown → multi-select × 2 across PM/onsite/maintenance) and the existing TeamPage already houses per-property scope refinement. The form collects only what's needed for a valid scope row at insert time. |
| Default `allProperties` to true or false? | False. The conservative default is no implicit blanket access — landlord should make a deliberate choice. Toggle is one click if they want it. |
| Default `accessLevel` for bookkeeper to read_only or read_write? | Read-only. Lower-privilege default is correct posture for an unfamiliar bookkeeper; landlord can upgrade after acceptance via the existing bookkeeper row controls. |
| Inline success message vs toast vs page-level alert? | Inline + auto-dismiss (4s). Toast infra not in this app; page-level alert is heavier than a 1-line confirmation needs to be. Auto-dismiss avoids stale-success-message clutter. |
| Show loading state on the submit button or render a global spinner? | Button text swaps to "Sending…" + disabled. The mutation is fast (<1s typically); a global spinner is overkill. |
| Maintenance job categories: chip multiselect or `<select multiple>`? | Chip multiselect. Native multi-select is unfriendly (needs cmd-click); chips communicate selection state at a glance and match the form's visual weight. |
| Keep the books-portal direct-create variant? | Yes. It's a separate convenience flow — admin sets a password and hands credentials to the bookkeeper directly. Different use case (e.g., bulk onboarding by an admin who already has the bookkeeper's password from elsewhere). Documented at `apps/api/src/routes/books.ts:655-660`. |

## Carry-forward — S230+

### Per-property scope picker (still open)

After an invite is accepted, scope rows insert with `propertyIds: []`
unless `allProperties` was checked at invite time. There's currently
**no UI on TeamPage to refine which specific properties** a PM /
onsite manager / maintenance worker has access to — the only knobs
exposed are the permissions toggles. The backend supports this via
`PATCH /api/scopes/:roleType/:userId` with `{ propertyIds, unitIds, ... }`.

If/when this becomes a real workflow ("I want this maintenance worker
on properties A, B, C only"), the TeamPage member row needs an
"Edit scope" expansion that loads the landlord's properties + units
and renders a multi-select per scope row. Half-to-full session.

For S229's scope, `allProperties=true` covers the common case (small
landlords give workers access to everything they own); the
`allProperties=false` path is functional but the worker has access
to nothing until refined through the API directly.

### Already-known carry-forward (unchanged)

See `DEFERRED.md` "Open — pick one" section for the current queue.

---

End of S229 handoff.
