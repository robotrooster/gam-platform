#!/usr/bin/env node
/**
 * S626 — what can a landlord or tenant still do that their agent cannot?
 *
 * Prints the remaining gap, biggest area first, so a session can pick up
 * top-down without re-deriving anything. actionParity.test.ts ratchets the
 * number; this tells you WHERE it is.
 *
 *   node apps/api/scripts/action-gap.js
 */
const fs = require('fs'), path = require('path')
const ROUTES = path.join(__dirname, '..', 'src', 'routes')
const ACTIONS = path.join(__dirname, '..', 'src', 'services', 'agents', 'portalActions.ts')

// Other portals, public surfaces, and features switched off. Not a gap.
const SILOED = new Set(['admin','adminOps','businesses','businessCustomers','businessInventory',
  'businessPos','businessQuotes','businessUsers','businessWorkOrders','businessAttachments','pos','pm',
  'platform','routes','depots','dumpLocations','vehicles','terminal','propane','publicPropertyBooking',
  'publicBooking','publicCustomerPortal','publicCardUpdate','propertyBookingAdmin','subleases',
  'subleaseInvitations','telemetry','stripeWebhook','webhooks','appointments',
  'posCustomerOnboarding','posLock'])
// Claude must never do these at all.
const FORBIDDEN = new Set(['auth','totp','emailOtp','stripe'])

const counts = {}
for (const fn of fs.readdirSync(ROUTES)) {
  if (!fn.endsWith('.ts') || fn.endsWith('.test.ts')) continue
  const area = fn.slice(0, -3)
  // Any business-portal file, however it is named — the explicit list rotted
  // the moment businessInvoices and businessDiscounts were added.
  if (/^business/i.test(area) || SILOED.has(area) || FORBIDDEN.has(area)) continue
  const src = fs.readFileSync(path.join(ROUTES, fn), 'utf8')
  const n = (src.match(/^\s*\w+Router\.(post|patch|put|delete)\(\s*'/gm) || []).length
  if (n) counts[area] = n
}

// Areas an allowlisted action already reaches.
const manifest = fs.readFileSync(ACTIONS, 'utf8')
const covered = new Set()
for (const m of manifest.matchAll(/path: '\/api\/([a-z0-9-]+)/g)) covered.add(m[1])
const alias = { 'bank-feed': 'bankFeed', 'entry-requests': 'entryRequests',
  'work-trade': 'workTrade', 'declared-deposits': 'declaredDeposits',
  'common-areas': 'commonAreas', autopay: 'tenantAutopay' }
const coveredAreas = new Set([...covered].map((c) => alias[c] || c))
// Areas reached by a HAND-BUILT tool rather than the manifest. Without these
// the report calls maintenance and notifications untouched, which is wrong and
// would send a session off to rebuild what already works.
for (const a of ['maintenance','notifications','surveys','inspections','commonAreas',
                 'serviceInterruptions','expenses','entryRequests','leases','agent']) {
  coveredAreas.add(a)
}

const rows = Object.entries(counts).sort((a, b) => b[1] - a[1])
const open = rows.filter(([a]) => !coveredAreas.has(a))
const total = rows.reduce((s, [, n]) => s + n, 0)
const openN = open.reduce((s, [, n]) => s + n, 0)

console.log(`\n${total} reachable actions · ${total - openN} in areas the agent can act on · ${openN} still untouched\n`)
console.log('AREAS WITH NO AGENT ACTION AT ALL, biggest first:')
for (const [a, n] of open) console.log(`  ${String(n).padStart(3)}  ${a}`)
console.log('\nAREAS ALREADY REACHED (may still be partial):')
for (const [a, n] of rows.filter(([a]) => coveredAreas.has(a))) console.log(`  ${String(n).padStart(3)}  ${a}`)
