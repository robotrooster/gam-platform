#!/usr/bin/env node
/**
 * S626/S628 — what can a landlord or tenant still do that their agent cannot?
 *
 *   node apps/api/scripts/action-gap.js          # summary
 *   node apps/api/scripts/action-gap.js units    # every open endpoint in one area
 *
 * S626 measured this by AREA: a file with one allowlisted action counted as
 * "reached" and its other twenty endpoints disappeared from the report. That
 * was fine while whole areas were untouched and useless the moment they were
 * not — after S628 the six biggest areas all have actions in them and the area
 * view says almost nothing. This resolves each route to its real METHOD+PATH
 * and matches it against the manifest, so what prints is the endpoints that
 * actually have no action.
 *
 * Three things are NOT gaps and are separated out rather than left to be
 * rediscovered: other portals and shelved features (SILOED), credentials and
 * card entry (FORBIDDEN), and a handful of endpoints that are deliberately not
 * agent actions for a stated reason (DELIBERATE) — a screening decision, a
 * permissions change, a bank number. A session that "closes" one of those is
 * undoing a decision, not making progress.
 */
const fs = require('fs'), path = require('path')
const API = path.join(__dirname, '..', 'src')
const ROUTES = path.join(API, 'routes')
const ACTIONS = path.join(API, 'services', 'agents', 'portalActions.ts')

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
  'background POST /payment-intent': 'Stripe payment entry',
  'background POST /pool/match/:matchId/payment-intent': 'Stripe payment entry',
  'background POST /upload-id': 'an identity document is uploaded by the person, not the agent',
  'background POST /submit': 'the applicant enters their own SSN and identity details',
  'scopes POST /:roleType/invite': 'permissions and access are a hard stop in every profile',
  'scopes PATCH /:roleType/:userId/permissions': 'permissions hard stop',
  'scopes PATCH /:roleType/:userId': 'permissions hard stop',
  'scopes DELETE /:roleType/:userId': 'permissions hard stop',
  'scopes POST /invitations/:id/resend': 'permissions hard stop',
  'scopes POST /invitations/:id/revoke': 'permissions hard stop',
  'scopes POST /:token/accept': 'accepting an invitation is a credential flow',
  'landlords POST /members': 'permissions hard stop',
  'landlords DELETE /members/:id': 'permissions hard stop',
  'landlords POST /member-invite/:token/accept': 'credential flow',
  'landlords POST /me/otp/tenants/:tenantId/enable': 'On-Time Pay is shelved and landlord-only',
  'landlords POST /me/otp/tenants/:tenantId/disable': 'On-Time Pay is shelved and landlord-only',
  'landlords POST /pos-customers': 'POS is its own product and stays isolated',
  'landlords DELETE /pos-customers/:id': 'POS isolation',
  'landlords POST /pos-customers/:id/send-onboarding': 'POS isolation',
  'bankAccounts POST /': 'adding an account takes a routing and account number — entered by the person, never through the agent',
  'properties POST /units/:id/photos': 'file upload',
  'properties DELETE /units/:id/photos/:photoId': 'file upload',
  'documents POST /': 'file upload',
  'tenantWalkthroughs POST /media': 'file upload',
}))

/** router variable -> route-file area. */
function routerAreas() {
  const out = {}
  for (const fn of fs.readdirSync(ROUTES)) {
    if (!fn.endsWith('.ts') || fn.endsWith('.test.ts')) continue
    const src = fs.readFileSync(path.join(ROUTES, fn), 'utf8')
    for (const m of src.matchAll(/export const (\w+Router)\s*[:=]/g)) out[m[1]] = fn.slice(0, -3)
  }
  return out
}

/** '/api/units' -> router variable. Mounts may have more than two segments. */
function mounts() {
  const src = fs.readFileSync(path.join(API, 'index.ts'), 'utf8')
  const out = {}
  for (const m of src.matchAll(/app\.use\(\s*'(\/api\/[a-z0-9/-]+)'\s*,\s*([\s\S]{0,140}?)\)/g)) {
    const r = (m[2].match(/(\w+Router)/) || [])[1]
    if (r) out[m[1]] = r
  }
  return out
}

const norm = (p) => (p.replace(/:[A-Za-z0-9_]+/g, ':x') || '/')

const AREAS = routerAreas()
const MOUNTS = mounts()
const MOUNT_OF = {}          // router -> longest mount serving it
for (const [base, r] of Object.entries(MOUNTS)) {
  if (!MOUNT_OF[r] || base.length > MOUNT_OF[r].length) MOUNT_OF[r] = base
}

// Every mutating endpoint, keyed the way the manifest can be compared to it.
const endpoints = []
for (const fn of fs.readdirSync(ROUTES)) {
  if (!fn.endsWith('.ts') || fn.endsWith('.test.ts')) continue
  const area = fn.slice(0, -3)
  if (/^business/i.test(area) || SILOED.has(area) || FORBIDDEN.has(area)) continue
  const src = fs.readFileSync(path.join(ROUTES, fn), 'utf8')
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
const manifest = fs.readFileSync(ACTIONS, 'utf8')
const reached = new Set()
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
const toolSrc = fs.readdirSync(path.join(API, 'services', 'agents', 'tools'))
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  .map((f) => fs.readFileSync(path.join(API, 'services', 'agents', 'tools', f), 'utf8'))
  .join('\n')
const missingTools = [...new Set(Object.values(HAND_BUILT))]
  .filter((n) => !toolSrc.includes(`name: '${n}'`))
if (missingTools.length) {
  console.error(`\n!! HAND_BUILT names no tool defines: ${missingTools.join(', ')}`)
  console.error('   Fix the map in this script — until then the count above is too generous.\n')
}
for (const k of Object.keys(HAND_BUILT)) reached.add(k)

const openOnes = endpoints.filter((e) =>
  !reached.has(e.key) && !DELIBERATE.has(`${e.area} ${e.declared}`))
const deliberate = endpoints.filter((e) => DELIBERATE.has(`${e.area} ${e.declared}`))

const only = process.argv[2]
if (only) {
  const rows = openOnes.filter((e) => e.area === only)
  console.log(`\n${only}: ${rows.length} endpoints with no agent action\n`)
  for (const e of rows) console.log(`  ${e.declared}`)
  const d = deliberate.filter((e) => e.area === only)
  if (d.length) {
    console.log(`\n${only}: deliberately not agent actions`)
    for (const e of d) console.log(`  ${e.declared}\n      ${DELIBERATE.get(`${e.area} ${e.declared}`)}`)
  }
  console.log()
  process.exit(0)
}

const byArea = {}
for (const e of openOnes) byArea[e.area] = (byArea[e.area] || 0) + 1
const rows = Object.entries(byArea).sort((a, b) => b[1] - a[1])

console.log(`\n${endpoints.length} mutating endpoints a landlord or tenant agent could reach`)
console.log(`${endpoints.length - openOnes.length - deliberate.length} have an agent action`)
console.log(`${deliberate.length} are deliberately not agent actions`)
console.log(`${openOnes.length} still have none\n`)
console.log('STILL OPEN, biggest first —  node scripts/action-gap.js <area>  for the list:')
if (!rows.length) console.log('  (none)')
for (const [a, n] of rows) console.log(`  ${String(n).padStart(3)}  ${a}`)
console.log('\nDELIBERATELY NOT AGENT ACTIONS — do not "close" these:')
const dByArea = {}
for (const e of deliberate) dByArea[e.area] = (dByArea[e.area] || 0) + 1
for (const [a, n] of Object.entries(dByArea).sort((x, y) => y[1] - x[1])) {
  console.log(`  ${String(n).padStart(3)}  ${a}`)
}
console.log()
