# Session 149 Handoff

**Theme:** Landlord notifications inbox added — closes the
parity gap with the tenant portal's `/notifications` route.
The header NotificationBell stays as a quick-glance dropdown;
the new page is the full inbox with filters + per-row
deep-link out to the underlying resource.

## Items shipped

### Landlord NotificationsPage

New page at `/notifications` mirroring the tenant inbox shape
but adapted for landlord-relevant notification types:

- All / Unread tab toggle
- Mark-all-read action (when unread count > 0)
- Per-row: gold/grey dot tone (unread/read), title, friendly
  type label, timestamp, body, email_sent / sms_sent badges
- Per-row deep-link button via `deepLinkFor()` helper that
  inspects the notification's `data` JSONB for the relevant
  resource id (inspection_id, entry_request_id, lease_id,
  dispute_id, etc.) and routes to the matching landlord page
- Per-row "Mark read" individual action

Type label map covers the ~14 notification types the landlord
might receive (`rent_collected`, `rent_failed`, ach retry,
disbursement_sent, maintenance, inspection x3, entry_request,
lease_expiring, low_stock, tenant_invite_accepted,
dispute_resolved). Unmapped types fall back to the snake_case
key with underscores spaced.

### NotificationBell footer link

Added a "View all notifications →" link at the bottom of the
header bell dropdown. Bell stays as the 30-row quick-glance
preview; new page is the full inbox.

### Route + nav

Route `/notifications` mounted in main.tsx. No nav-rail entry
added — the bell is the discoverable entrypoint, and the page
is reached via the dropdown footer link. Adding a nav rail
entry would clutter; the bell + link pattern matches mainstream
PMS apps.

## Files touched / created

```
apps/landlord/src/pages/NotificationsPage.tsx       (new — 160 lines)
apps/landlord/src/main.tsx                          (route)
apps/landlord/src/components/NotificationBell.tsx   (footer link added)
```

No backend changes — `/api/notifications`, `/:id/read`, and
`/read-all` already exist and serve both the tenant and
landlord portals.

## Validation

- `npx tsc --noEmit` on api / landlord / tenant / admin → all exit 0
- No live smoke needed (read-only render of existing endpoint)

## Pre-launch frontend status

Closed list updates:
- ✅ Landlord notifications inbox (parity with tenant portal)
- ✅ NotificationBell deep-links to inbox

Open items unchanged from S148:
- PM third-party-companies subsystem (full build, product input)
- `lease_fees due_timing` full wire-up (product call; alert in place)
- OTP enablement (product call)
- Stripe sandbox testing (test key)
- Live browser smoke walkthrough (interactive)

## What next session should target

Visible autonomous-friendly items remaining:

1. **Live browser smoke walkthrough** — biggest open item;
   needs you at the keyboard.
2. **Bookings PATCH UX** — read-only list today; click-to-edit
   panel for status/notes/dates would close the loop.
3. **Tenant payments → my-record cross-link** — small UX polish.
4. **Property Intelligence portal review** — port 3007 has its
   own portal that hasn't been touched in this conversation.
   Worth confirming it's healthy.
5. **Tax form catalog scaffold** — landlord-configurable
   per-state catalog. Real session.

Recommendation: option 4 (Property Intelligence audit) since
it's a passive recon pass that may surface real issues without
committing to a build.

## Notes for future-Claude

- The `deepLinkFor()` helper inspects `notification.data`
  JSONB. New notification types with new linkable resources
  need to be added to that map. The JSON shape is:
  `data.inspection_id` for inspection events,
  `data.entry_request_id` for entry workflow,
  `data.dispute_id` for dispute events.
- The bell and page both read `/notifications?limit=30` and
  `?limit=100` respectively. They share the `notifications`
  query key with the bell — wait, the bell uses
  `'notifications'` and the page uses `'notifications-inbox'`.
  Intentional split so marking-read on the page doesn't
  invalidate the bell's polling cache and vice versa. Both
  refetch on their own intervals.
- The `/notifications` href in the bell footer is a plain
  anchor, not a NavLink — the bell is rendered inside Layout
  but not wrapped in a Router context that would let
  react-router's NavLink work seamlessly. Plain `<a>` causes
  a brief reload but works correctly. Future polish: wrap in
  a useNavigate hook.
