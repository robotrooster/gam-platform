# SESSION 501 HANDOFF

## Theme
Agent arc continuation. Two pieces:
**(A)** finished the S498 agent revenue-permissions arc by shipping the
**property-settings UI toggle** (the last open piece — backend service +
in-chat tool existed, no landlord UI).
**(B)** built the **booking-guest identity track** (one of the two queued
agent tracks from 2026-06-17): a no-account booking guest can talk to a
token-scoped guest agent. Broadest scope chosen by Nic — backend
foundation + QR delivery + light guest actions + landlord QR surface.

## Status snapshot
- **Tests:** all affected suites green.
  - `tools.test.ts` 107 (+5 guest-tool/allowlist), `agent.test.ts` 13
    (+4 guest-route), `bookingGuestTokens.test.ts` 7 (new),
    `properties.test.ts` 29 (+5 agent-permissions), `units.test.ts` 14,
    `bookings.test.ts` 8.
- **Builds:** packages/shared built; apps/api tsc clean (pre-existing
  `ingest*` errors filtered); apps/landlord tsc clean.
- **Migrations:** `20260618130000_booking_guest_access.sql` applied +
  recorded. schema.sql regenerated.
- **Dev work:** no commits, no pushes.

## Shipped

### (A) Agent permissions — property-settings UI toggle
- Backend: `GET` + `PATCH /api/properties/:id/agent-permissions`
  (`routes/properties.ts`) → calls existing `services/agentPermissions.ts`
  (`listAgentPermissions` / `setAgentCapability`). zod-validated against
  shared `AGENT_REVENUE_CAPABILITIES`, landlord-ownership gated
  (`canManageLandlordResource` + `requirePerm('properties.edit')`).
- Frontend: `pages/PropertyAgentPermissionsSection.tsx` (new) — toggle
  card on `PropertyDetailPage`, below the fee schedule. Surfaces ONLY the
  2 live capabilities (`lease_renewal`, `bill_fee`); `take_payment`
  omitted (reframed to ACH-guidance, no agent action behind it).
- Verified end-to-end: `billFee` + `requestLeaseRenewal` both call
  `isAgentCapabilityEnabled` — the toggle is honored, not cosmetic.
- Also confirmed S498-deferred `flagApplicantDecision` (162L) +
  `draftTenantNotice` (109L) are complete and allowlisted. The S498
  agent-action arc is fully done.

### (B) Booking-guest identity track
Mechanism: a per-booking access token (mirrors
`business_customer_payment_update_tokens`) — but **reusable through the
stay**, expiring at checkout + 2-day buffer. Token = bearer credential
for a THIRD agent door, alongside authenticated `/api/agent/chat` and
public `/api/sales/chat`.

- **Migration** `20260618130000`: `booking_guest_access_tokens`
  (token, booking_id, landlord_id, delivery_method email|qr, expires_at,
  revoked_at, last_used_at), `booking_change_requests` (the light-action
  records: request_type, details, status), and widened
  `agent_interaction_logs.audience` CHECK to admit `'guest'`.
- **Shared:** `BOOKING_CHANGE_REQUEST_TYPES`
  (late_checkout/early_checkin/extra_night/other) + `_STATUSES` + labels.
- **Service** `services/bookingGuestTokens.ts`: `issueBookingGuestToken`,
  `resolveBookingGuestToken` (fails closed on unknown/revoked/expired;
  stamps last_used_at), `bookingGuestQrDataUrl` (uses `qrcode` dep),
  `sendBookingGuestAccessEmail`. Email helper `emailBookingGuestAccess`
  in `services/email.ts`.
- **Agent plumbing:** `'guest'` added to `AGENT_AUDIENCES`; `AgentActor`
  gained `bookingId?` (set only for guests; tools scope to it).
  `GUEST_ENTRY` profile in `profiles.ts` (persona "Skye", single tier,
  `knowledgeScopes:['shared']`, tools `get_guest_booking` +
  `request_booking_change`). Session audience-actor match + logInteraction
  attribution (guest → booking's landlord; actor_user_id NULL — FK to
  users, no account) + `loadGuestConversationHistory` (keys on
  actor_profile_id = bookingId, since actor_user_id is NULL).
- **Guest tools:** `getGuestBooking.ts` (read the one stay; exports
  `loadGuestBookingContext`), `requestBookingChange.ts` (records a
  host-directed change request + notifies the host; dedups open requests;
  draft-with-approval — host finalizes, agent never commits).
- **Route:** `guestAgentRouter` (`POST /api/guest/chat`) — token in body,
  resolves → guest actor bound to that one booking, rate-limited by token.
  Mounted at `/api/guest` in `index.ts`.
- **Token issuance:** fired best-effort on booking-create
  (`POST /api/units/:id/bookings`) when guest_email present (never fails
  the booking). New landlord endpoint
  `POST /api/units/:id/bookings/:bookingId/guest-access` → returns
  `{url, qrDataUrl, expiresAt, emailed}`; optional `sendEmail`.
- **Frontend (landlord QR surface):** `SchedulePage.tsx` list-view
  booking cards got a "Guest link" button → modal with QR image,
  copyable link, expiry note, and "Email link to <guest>" when an email
  is on file.

## Decisions made (this session)
- Permissions toggle exposes only the 2 live capabilities (Nic).
- Guest agent scope = read + light actions (Nic). Light action =
  `request_booking_change`, host approves; agent never commits.
- Guest identity = reusable per-booking token, email-link + QR (no SMS).
- Guest page URL convention: `${MARKETING_URL}/stay/:token` (the
  guest-facing page itself is NOT built yet — see below).

## Still open / next session
- **Guest-facing stay page** (`/stay/:token` on the marketing site,
  port 3004) with the chat widget calling `/api/guest/chat`. The token
  resolves and the agent works; there's just no guest UI yet (today the
  guest gets the QR/link, but the page it points to needs building).
- **Host-side review of booking_change_requests** — the records +
  host notifications land, but there's no landlord surface to
  approve/decline them yet (mirrors the renewal-request gap). Wire an
  approve/decline UI + status transitions.
- **Token revoke UI** — `revoked_at` exists + resolve honors it; no
  landlord button to revoke a guest link yet.
- The other queued agent track — **agent-guided inspection walkthrough**
  (camera capture, B1 standard-area checklist into shared) — untouched.

## Notes
- Benign test log noise: the booking-create guest-email fire is
  fire-and-forget; in `bookings.test.ts` it runs after `cleanupAllSchema`
  removed the landlord, so `email_send_log` FK errors log + are swallowed
  (`.catch`). No test fails. Matches existing email-path posture.
- No smoke walk proposed. No commit proposed.
