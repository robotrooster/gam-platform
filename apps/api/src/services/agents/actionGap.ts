/**
 * S628 — WHAT CAN A LANDLORD OR TENANT STILL DO THAT THEIR AGENT CANNOT?
 *
 * This was a script under scripts/. It is a module now because the answer had
 * become zero, and a number nothing asserts drifts back the moment somebody
 * adds a route. actionGap.test.ts holds it at zero: a new mutating endpoint has
 * to be either given an agent action or named in DELIBERATE with the reason it
 * is not one. "I did not think about it" stops being a possible state.
 *
 * The CLI still works and is still the thing to run while working:
 *
 *   node apps/api/scripts/action-gap.js          # summary
 *   node apps/api/scripts/action-gap.js units    # every endpoint in one area
 *
 * S626 counted by AREA — one allowlisted action marked a whole file covered and
 * its other twenty endpoints disappeared. This resolves each route to its real
 * METHOD and PATH and matches it against the manifest.
 */
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'

const API = join(__dirname, '..', '..')
const ROUTES = join(API, 'routes')
const ACTIONS = join(__dirname, 'portalActions.ts')

const SILOED = new Set(['admin','adminOps','businesses','businessCustomers','businessInventory',
  'businessPos','businessQuotes','businessUsers','businessWorkOrders','businessAttachments','pos','pm',
  'platform','routes','depots','dumpLocations','vehicles','terminal','propane','publicPropertyBooking',
  'publicBooking','publicCustomerPortal','publicCardUpdate','propertyBookingAdmin','subleases',
  'subleaseInvitations','telemetry','stripeWebhook','webhooks','appointments',
  'posCustomerOnboarding','posLock',
  // Business-portal surfaces not named business*: every route in
  // recurringSchedules gates on requireBusinessId.
  'recurringSchedules',
  // Shelved by directive — one flag kills lot rent along with subleasing.
  'lotRent'])
const FORBIDDEN = new Set(['auth','totp','emailOtp','stripe'])

/** Endpoints deliberately left unreachable, and why. METHOD + declared path. */
const DELIBERATE = new Map(Object.entries({
  'background PATCH /:id/decision':
    'record-intent-only by directive (FCRA / fair housing) — flag_applicant_decision captures the landlord\'s intent and routes them to record it themselves',
  'background POST /:id/adverse-action':
    'the required applicant notice is the landlord\'s to send, same directive',
  'background POST /payment-intent': 'Stripe payment entry, which belongs to Stripe\'s own elements',
  'background POST /pool/match/:matchId/payment-intent': 'Stripe payment entry, which belongs to Stripe\'s own elements',
  'background POST /upload-id': 'an identity document is uploaded by the person, not the agent',
  'background POST /submit': 'the applicant enters their own SSN and identity details',
  'scopes POST /:roleType/invite': 'permissions and access are a hard stop in every profile',
  'scopes PATCH /:roleType/:userId/permissions': 'changing what somebody can see or do is a hard stop in every profile',
  'scopes PATCH /:roleType/:userId': 'changing a team member\'s role is a permissions change',
  'scopes DELETE /:roleType/:userId': 'removing somebody\'s access is a permissions change',
  'scopes POST /invitations/:id/resend': 'a team invitation grants access; permissions hard stop',
  'scopes POST /invitations/:id/revoke': 'a team invitation grants access; permissions hard stop',
  'scopes POST /:token/accept': 'accepting an invitation is a credential flow',
  'landlords POST /members': 'adding a team member grants access; permissions hard stop',
  'landlords DELETE /members/:id': 'removing a team member changes access; permissions hard stop',
  'landlords POST /member-invite/:token/accept': 'accepting an invitation sets up an account',
  'landlords POST /me/otp/tenants/:tenantId/enable': 'On-Time Pay is shelved and landlord-only',
  'landlords POST /me/otp/tenants/:tenantId/disable': 'On-Time Pay is shelved and landlord-only',
  'landlords POST /pos-customers': 'POS is its own product and stays isolated',
  'landlords DELETE /pos-customers/:id': 'POS is its own product and stays isolated',
  'landlords POST /pos-customers/:id/send-onboarding': 'POS is its own product and stays isolated',
  'bankAccounts POST /': 'adding an account takes a routing and account number — entered by the person, never through the agent',
  'properties POST /units/:id/photos': 'unit photos are files the landlord uploads',
  'properties DELETE /units/:id/photos/:photoId': 'removing a photo is done looking at it',
  'documents POST /': 'a document is a file the person uploads',
  'tenantWalkthroughs POST /media': 'walkthrough photos and video are files taken on site',
  'expenses POST /:id/receipt': 'a receipt is a file the landlord uploads',
  'maintenance POST /:id/media': 'photos of the job are files taken on site',
  'maintenance POST /:id/receipts': 'a receipt is a file the worker uploads',
  'inspections POST /:id/photos': 'inspection photos are taken on site and uploaded there',
  'inspections POST /:id/videos': 'inspection video is taken on site and uploaded there',
  'esign POST /upload': 'the template PDF is a file the landlord uploads',
  'tenants POST /avatar': 'a profile photo is a file the tenant chooses',
  'landlords POST /me/pending-tenants/:intentId/document': 'the lease PDF is a file the landlord uploads',

  // A SIGNATURE IS THE PERSON'S. The agent never signs, never declines a
  // signature, and never accepts terms on somebody's behalf — an acceptance
  // records their IP and user-agent as evidence that THEY agreed.
  'esign POST /sign/:documentId': 'signing is the person\'s own act',
  'esign POST /sign/:documentId/decline': 'declining to sign is the person\'s own act',
  'inspections POST /:id/sign': 'signing is the person\'s own act',
  'inspections POST /:id/submit': 'the tenant submits their own periodic inspection',
  'tenants POST /lease/sign': 'signing a lease is the person\'s own act',
  'tenants POST /flexpay/enroll': 'enrolment records an acceptance of terms with their IP',
  'tenants POST /flexdeposit/enroll': 'enrolment records an acceptance of terms with their IP',
  'tenants POST /flexsuite/re-accept': 'accepting revised terms is the person\'s own act',
  'tenants POST /enroll-credit-reporting': 'consent to report to bureaus is the person\'s own act',
  'tenants POST /me/deposit/portability/authorize': 'takes a signature',
  'tenants POST /me/deposit/portability/decline': 'the counterpart of a signed authorisation',
  'landlords POST /complete-onboarding': 'takes the landlord\'s signature on the platform terms',
  'credit POST /attest': 'an attestation is the person\'s own statement, signed',

  // CREDENTIALS AND BANK VERIFICATION.
  'tenants POST /accept-invite': 'sets a password',
  'tenants PATCH /password': 'credential change',
  'tenants POST /verify-ach': 'bank verification — microdeposit amounts are entered by the person',
  'bankFeed POST /link-session': 'opens a bank-linking session; the person authenticates to their bank',
  'bankFeed POST /finalize': 'completes that bank-linking session',

  // MONEY THE AGENT MUST NOT MOVE, or that GAM does not offer here.
  'tenants POST /flexcharge/:accountId/pay': 'a card payment against a FlexCharge account',
  'tenants POST /flexdeposit/pay-ahead': 'moves money ahead of schedule',
  'tenants POST /flexcharge/dispute/:txId': 'a dispute is a hard stop in every profile',
  'credit POST /dispute': 'a dispute is a hard stop in every profile — it escalates to a human',
  'credit POST /dispute/:id/evidence': 'evidence on a dispute, which is a hard stop',
  'credit POST /dispute/:id/resolve': 'resolving a dispute is a human decision',
  'landlords POST /flex-charge/accounts': 'FlexCharge account setup is a financing product, not a portal chore',
  'landlords PATCH /flex-charge/accounts/:id': 'editing a FlexCharge account is the same financing decision as opening one',
  'landlords PATCH /flex-charge/finance-rate': 'setting a finance rate is a lending decision',

  // ADMIN-ONLY, DEV-ONLY, OR ANOTHER SURFACE ENTIRELY.
  'payments POST /initiate-rent-collection': 'requireAdmin — platform operations',
  'payments POST /:id/handle-return': 'requireAdmin — platform operations',
  'background POST /webhook/:providerName': 'a provider callback, not a person',
  'background POST /dev-mock-webhook': 'dev-only, requireAdmin',
  'background POST /dev-reset': 'dev-only, requireAdmin',
  'background POST /pool/match/:matchId/purchase-report': 'buys a screening report — a purchase',
  'featureRequests PATCH /:id': 'requireSuperAdmin — the GAM team triaging',
  'books POST /bookkeeper/assign': 'granting a bookkeeper access is a permissions change',
  'books DELETE /bookkeeper/revoke': 'revoking a bookkeeper is a permissions change, same hard stop as granting one',
  'scopes PATCH /property_manager/:userId/direct-deposit': 'somebody else\'s bank details',
  'utility POST /bills/:id/pay': 'deprecated at S178 — utilities are line items on the rent invoice',
  'tenants POST /:id/transfer': 'retired at S20 — returns 501; a transfer is terminate + re-sign',
  'units DELETE /:id': 'GAM never erases — retire_unit is how a unit is removed',
  'books DELETE /transactions/:id': 'GAM never erases — correct it with update_book_transaction',
  'properties POST /:id/transfer': 'moves ownership of a property to another account by email; owner-only, and too easy to aim at a mistyped address',
  'esign PUT /templates/:id/fields': 'field geometry on a PDF — placed visually, not described',
  'esign DELETE /templates/:id/fields/:fieldId': 'field geometry on a PDF — removed visually, not described',
  'esign POST /documents': 'takes a hand-assembled signer list; draft_household_lease is the safe path',
  'esign POST /standalone-documents': 'takes the same hand-assembled signer list as POST /documents',
  'esign POST /documents/addendum-terms/batch': 'the batch form of an action the agent already has one at a time',
  'homeSale POST /': 'creates a financed sale contract with an amortisation schedule — a lending instrument',

  // FILE IMPORTS. A CSV is a file the landlord uploads and reviews; there is
  // nothing for an agent to supply and a bad import lands on hundreds of rows.
  'landlords POST /me/onboard-properties-csv/validate': 'a CSV is a file the landlord uploads and reviews',
  'landlords POST /me/onboard-properties-csv/commit': 'commits an import the landlord reviewed on screen',
  'landlords POST /me/onboard-tenants-csv/validate': 'a CSV is a file the landlord uploads and reviews',
  'landlords POST /me/onboard-tenants-csv/commit': 'commits an import the landlord reviewed on screen; a bad one lands on hundreds of rows',
  'landlords POST /me/onboard-tenants-csv/commit-pending': 'commits an import the landlord reviewed on screen',
  'landlords POST /me/onboard-payment-history-csv/validate': 'a CSV is a file the landlord uploads and reviews',
  'landlords POST /me/onboard-payment-history-csv/commit': 'commits imported payment history the landlord reviewed on screen',
  'tenants POST /flexpay/inquiry/proof': 'proof of income is a file the tenant uploads',

  // THE AGENT'S OWN PLUMBING. Sending a message to an agent is not a portal
  // action, and an agent calling its own chat endpoint is a loop.
  'agent POST /chat': "the agent's own conversation endpoint — calling it would be a loop",
  'agent POST /:slug/agent/chat': "a booking site's own agent endpoint, not a portal action",
  'agent POST /call-slots/book': 'the sales agent books these through its own tool',
  'agent POST /demo': 'the sales agent books these through its own tool',
  'agent POST /onboarding': "the onboarding agent's own endpoint",

  // SUPERSEDED, OR SOMEBODY ELSE'S SURFACE.
  'payments POST /:id/pay': 'pay_my_balance settles the lease balance and is the path the agent takes',
  'credit POST /score/:subjectId/recompute': 'requireLendingService — an internal service, not a person',
  'portfolio POST /onboarding/resend': 'the sales-rep portfolio surface, not a landlord or tenant one',
}))

/** router variable -> route-file area. */
function routerAreas(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const fn of readdirSync(ROUTES)) {
    if (!fn.endsWith('.ts') || fn.endsWith('.test.ts')) continue
    const src = readFileSync(join(ROUTES, fn), 'utf8')
    for (const m of src.matchAll(/export const (\w+Router)\s*[:=]/g)) out[m[1]] = fn.slice(0, -3)
  }
  return out
}

/** '/api/units' -> router variable. Mounts may have more than two segments. */
function mounts(): Record<string, string> {
  const src = readFileSync(join(API, 'index.ts'), 'utf8')
  const out: Record<string, string> = {}
  for (const m of src.matchAll(/app\.use\(\s*'(\/api\/[a-z0-9/-]+)'\s*,\s*([\s\S]{0,140}?)\)/g)) {
    const r = (m[2].match(/(\w+Router)/) || [])[1]
    if (r) out[m[1]] = r
  }
  return out
}

const norm = (p: string) => (p.replace(/:[A-Za-z0-9_]+/g, ':x') || '/')

const AREAS = routerAreas()
const MOUNTS = mounts()
const MOUNT_OF: Record<string, string> = {}          // router -> longest mount serving it
for (const [base, r] of Object.entries(MOUNTS)) {
  if (!MOUNT_OF[r] || base.length > MOUNT_OF[r].length) MOUNT_OF[r] = base
}

export interface Endpoint {
  area: string
  router: string
  method: string
  /** METHOD + the path the route file declares, e.g. 'POST /:id/cancel'. */
  declared: string
  /** METHOD + the full normalised path, matched against the manifest. */
  key: string
}

// Every mutating endpoint, keyed the way the manifest can be compared to it.
const endpoints: Endpoint[] = []
for (const fn of readdirSync(ROUTES)) {
  if (!fn.endsWith('.ts') || fn.endsWith('.test.ts')) continue
  const area = fn.slice(0, -3)
  if (/^business/i.test(area) || SILOED.has(area) || FORBIDDEN.has(area)) continue
  const src = readFileSync(join(ROUTES, fn), 'utf8')
  for (const m of src.matchAll(/^\s*(\w+Router)\.(post|patch|put|delete)\(\s*'([^']*)'/gm)) {
    const [, router, verb, sub] = m
    // A public router is a public surface — a prospect applying for a unit is
    // not a landlord or tenant action however the file is named.
    if (/^public/i.test(router)) continue
    const mount = MOUNT_OF[router]
    if (!mount) continue                       // not mounted — dead router
    const mountArea = AREAS[router]
    if (mountArea && (SILOED.has(mountArea) || /^business/i.test(mountArea))) continue
    endpoints.push({
      area, router,
      method: verb.toUpperCase(),
      declared: `${verb.toUpperCase()} ${sub || '/'}`,
      key: `${verb.toUpperCase()} ${mount}${norm(sub)}`.replace(/\/$/, '') || mount,
    })
  }
}

// Everything the allowlist reaches, keyed the same way.
const manifest = readFileSync(ACTIONS, 'utf8')
const reached = new Set<string>()
for (const m of manifest.matchAll(/audience: '\w+', method: '(\w+)', path: '([^']+)'/g)) {
  reached.add(`${m[1]} ${norm(m[2])}`.replace(/\/$/, ''))
}
for (const m of manifest.matchAll(/method: '(\w+)',\s*\n?\s*path: '([^']+)'/g)) {
  reached.add(`${m[1]} ${norm(m[2])}`.replace(/\/$/, ''))
}
/**
 * Endpoints reached by a HAND-BUILT tool rather than the allowlist.
 *
 * These predate the dispatcher and mostly write SQL directly, so there is no
 * path string to scrape — the mapping has to be stated. It is stated WITH THE
 * TOOL NAME so it can be audited: if a tool is renamed or deleted and this is
 * not updated, the report quietly calls a real gap covered, which is the
 * failure mode that matters. The names are checked below against the tools
 * directory.
 */
const HAND_BUILT = {
  'POST /api/maintenance':                          'file_maintenance_request',
  'PATCH /api/maintenance/:x':                      'cancel_maintenance_request',
  'POST /api/maintenance/:x/comments':              'add_maintenance_comment',
  'POST /api/maintenance/:x/approve':               'approve_maintenance_request',
  'POST /api/maintenance/:x/reject':                'reject_maintenance_request',
  'POST /api/maintenance/:x/assign':                'assign_maintenance_request',
  'POST /api/maintenance/:x/schedule':              'schedule_maintenance',
  'PATCH /api/notifications/:x/read':               'mark_notifications_read',
  'PATCH /api/background/notifications/:x/read':    'mark_notifications_read',
  'PATCH /api/notifications/read-all':              'mark_notifications_read',
  'PATCH /api/notifications/preferences':           'update_notification_preference',
  'POST /api/notifications/bulk':                   'send_bulk_message',
  'POST /api/surveys':                              'create_and_send_survey',
  'POST /api/surveys/:x/send':                      'create_and_send_survey',
  'POST /api/surveys/tenant/:x/respond':            'submit_survey_response',
  'POST /api/inspections':                          'create_inspection',
  'POST /api/inspections/:x/items':                 'set_inspection_item_condition',
  'POST /api/expenses':                             'log_expense',
  'POST /api/entry-requests/:x/respond':            'respond_to_entry_request',
  'POST /api/service-interruptions':                'post_service_interruption',
  'POST /api/service-interruptions/:x/resolve':     'resolve_service_interruption',
  'POST /api/common-areas/:x/request':              'request_amenity_reservation',
  'POST /api/common-areas/reservations/:x/decide':  'decide_amenity_reservation',
  'POST /api/leases/:x/bill-fee':                   'bill_fee',
  'POST /api/leases/:x/renewal-intent':             'submit_renewal_intent',
  'POST /api/agent/escalate':                       'escalate',
  'PATCH /api/properties/:x/agent-permissions':     'set_agent_permission',
  'POST /api/payments/:x/record-manual':            'record_cash_payment',
}
// A named tool that no longer exists would silently widen "covered".
const toolSrc = readdirSync(join(__dirname, 'tools'))
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  .map((f) => readFileSync(join(__dirname, 'tools', f), 'utf8'))
  .join('\n')
const missingTools = [...new Set<string>(Object.values(HAND_BUILT))]
  .filter((n: string) => !toolSrc.includes(`name: '${n}'`))
for (const k of Object.keys(HAND_BUILT)) reached.add(k)

const openOnes = endpoints.filter((e) =>
  !reached.has(e.key) && !DELIBERATE.has(`${e.area} ${e.declared}`))
const deliberate = endpoints.filter((e) => DELIBERATE.has(`${e.area} ${e.declared}`))


export interface ActionGap {
  /** Every mutating endpoint a landlord or tenant agent could reach. */
  all: Endpoint[]
  /** Reached by the allowlist or by a hand-built tool. */
  covered: Endpoint[]
  /** Named in DELIBERATE, with the reason. */
  deliberate: Array<Endpoint & { why: string }>
  /** Neither. This is the gap, and it should be empty. */
  open: Endpoint[]
  /** HAND_BUILT names that no tool defines — the map has rotted. */
  missingTools: string[]
}

export function computeActionGap(): ActionGap {
  return {
    all: endpoints,
    covered: endpoints.filter((e) =>
      reached.has(e.key) && !DELIBERATE.has(`${e.area} ${e.declared}`)),
    deliberate: deliberate.map((e) => ({ ...e, why: DELIBERATE.get(`${e.area} ${e.declared}`)! })),
    open: openOnes,
    missingTools,
  }
}

export function reasonFor(e: Endpoint): string | undefined {
  return DELIBERATE.get(`${e.area} ${e.declared}`)
}
