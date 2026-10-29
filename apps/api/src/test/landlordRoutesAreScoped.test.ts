/**
 * 10/23 — A MUTATING LANDLORD-SIDE ENDPOINT IS SCOPED TO SOMETHING.
 *
 * The management portal folded into the landlord portal (PM_FOLD_PLAN.md),
 * which means somebody who is not the owner now reaches these routes: a
 * management company's staff, holding ONE property of an owner's portfolio, by
 * the owner's grant. Before the fold, "the caller is the landlord" was true
 * often enough that a route could lean on it.
 *
 * So this is a RATCHET, not a cleanup. Every landlord-side route file that
 * mutates must reach one of:
 *
 *   • a property gate — assertPropertyInScope / getScopedPropertyIds /
 *     assertChargeInStaffScope / assertPropertyIsLandlords; or
 *   • a company gate — landlordScopeIds / resolveLandlordTarget /
 *     landlordForRequest / canAccessLandlordResource / teamLandlordIds /
 *     getLandlordIdFromReq / isEntityMember; or
 *   • a line in UNSCOPED below, saying what gates it instead.
 *
 * A NEW file that reaches none of them fails this test. The files already in
 * UNSCOPED are a dated debt, each with what was actually verified about it —
 * not a blessing. Shrinking that list is its own work.
 *
 * Same shape as actionGap (every mutating endpoint is an agent action or
 * declared) and testsAreDeterministic. A rule that holds itself.
 */
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { describe, it, expect } from 'vitest'

const ROUTES = join(__dirname, '..', 'routes')

/** Surfaces that are not the landlord portal at all, and have their own gates. */
const OTHER_PORTALS = new Set([
  'admin', 'adminOps', 'platform', 'ledger',
  'pos', 'posCustomerOnboarding', 'posLock', 'terminal', 'propane',
  'pm',
  // The business portal: every route gates on requireBusinessAccess /
  // requireBusinessId (verified in businessInvoices and routes).
  'businesses', 'businessCustomers', 'businessInventory', 'businessPos', 'businessQuotes',
  'businessUsers', 'businessWorkOrders', 'businessAttachments', 'businessInvoices',
  'businessRecurringInvoices', 'businessDiscounts', 'businessVehicles',
  'businessBookableServices', 'recurringSchedules', 'routes', 'depots', 'dumpLocations', 'vehicles',
  // Public and webhook surfaces: no signed-in caller to scope.
  'publicPropertyBooking', 'publicBooking', 'publicCustomerPortal', 'publicCardUpdate',
  'propertyBookingAdmin', 'stripeWebhook', 'webhooks', 'telemetry', 'appointments',
  // Sign-in itself, and the shelved ones.
  'auth', 'totp', 'emailOtp', 'stripe', 'subleases', 'subleaseInvitations', 'lotRent',
])

/**
 * Landlord-side files that mutate and reach no property or company gate, with
 * what IS true about each. A dated debt (10/23), not an exemption: these were
 * read, and none of them is a hole a manager could walk through today.
 */
const UNSCOPED = new Map(Object.entries({
  booksLoansAssets:
    'gated by requireBooksRead / requireBooksWrite, which only a bookkeeper or a property manager '
    + 'holding books.view / books.edit passes; the rows themselves are company-keyed and a '
    + 'bookkeeper\'s company comes from their own scope row (lib/bookkeeperScope).',
  'maintenance-portal':
    'the maintenance worker\'s own portal: every route is requirePerm on a maintenance key, and the '
    + 'work it reaches is theirs by assignment. Worth a property gate when the fold gives a '
    + 'management company maintenance staff — on the list.',
  bankAccounts:
    'a bank account belongs to a USER (their own payout destination), not to a property; the rows '
    + 'are keyed by the signed-in user.',
  uiLayout:
    'one person\'s own saved screen arrangement. Keyed by user_id; there is nothing of a company\'s '
    + 'in it.',
  tenantAutopay:
    'a tenant\'s own autopay for their own lease. Not a landlord-side surface at all.',
  featureRequests:
    'anybody signed in may file one; the admin side is requireSuperAdmin.',
  portfolio:
    'one endpoint, /onboarding/resend, which re-sends an invitation the caller already owns.',
  tenantCredits:
    'both mutating routes are declared in the action-gap manifest as the owner\'s own press, and the '
    + 'credit they name is resolved against the caller\'s company inside the service.',
  signingPackages:
    'a signing packet is reached by its own token, which is the scope.',
  scopes:
    'the team-and-permissions surface itself: every route resolves the caller\'s company with '
    + 'teamLandlordIds (it is in the file, past the point this scan reads).',
  surveys: 'survey rows are keyed to the sender and read by token.',
  credit: 'the credit ledger is gated by requireLendingService; no landlord reaches it.',
  entryRequests: 'an entry request names its own lease, and the service resolves the company from it.',
  notifications: 'a person\'s own notification preferences — keyed by the signed-in user.',
  commonAreas: 'TO VERIFY — reached no gate in this scan and has not been read yet (10/23).',
  expenses: 'TO VERIFY — reached no gate in this scan and has not been read yet (10/23).',
  workTrade: 'TO VERIFY — reached no gate in this scan and has not been read yet (10/23).',
  background: 'TO VERIFY — reached no gate in this scan and has not been read yet (10/23).',
  booksClose: 'TO VERIFY — reached no gate in this scan and has not been read yet (10/23).',
  booksSettings: 'TO VERIFY — reached no gate in this scan and has not been read yet (10/23).',
  serviceInterruptions: 'TO VERIFY — reached no gate in this scan and has not been read yet (10/23).',
  utilityServiceAgreements: 'TO VERIFY — reached no gate in this scan and has not been read yet (10/23).',
  agent: 'TO VERIFY — reached no gate in this scan and has not been read yet (10/23).',
}))

const PROPERTY_GATES = ['assertPropertyInScope', 'getScopedPropertyIds', 'assertChargeInStaffScope',
  'assertPropertyIsLandlords']
const COMPANY_GATES = ['landlordScopeIds', 'resolveLandlordTarget', 'landlordForRequest',
  'canAccessLandlordResource', 'teamLandlordIds', 'getLandlordIdFromReq', 'isEntityMember',
  'landlordMembershipIds']

const MUTATES = /\w+Router\.(post|patch|put|delete)\(\s*'/

function landlordRouteFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      if (name.isDirectory()) { walk(join(dir, name.name)); continue }
      if (!name.name.endsWith('.ts') || name.name.includes('.test.')) continue
      const stem = name.name.replace(/\.ts$/, '')
      if (OTHER_PORTALS.has(stem)) continue
      out.push(join(dir, name.name))
    }
  }
  walk(ROUTES)
  return out
}

describe('a landlord-side route that changes something is scoped to something', () => {
  it('no NEW file mutates without a property gate, a company gate, or a reason', () => {
    const offenders: string[] = []
    for (const file of landlordRouteFiles()) {
      const text = readFileSync(file, 'utf8')
      if (!MUTATES.test(text)) continue
      const stem = file.split('/').pop()!.replace(/\.ts$/, '')
      if (PROPERTY_GATES.some(g => text.includes(g))) continue
      if (COMPANY_GATES.some(g => text.includes(g))) continue
      if (UNSCOPED.has(stem)) continue
      offenders.push(
        `\n  routes/${stem}.ts mutates and reaches no property or company gate`
        + `\n      → scope it (assertPropertyInScope with the property, or the company resolvers),`
        + ` or add it to UNSCOPED in this test with what gates it instead.`)
    }
    expect(offenders.join('')).toBe('')
  })

  it('and the debt list is honest — every entry names a real file and says something', () => {
    const live = new Set(landlordRouteFiles().map(f => f.split('/').pop()!.replace(/\.ts$/, '')))
    for (const [stem, why] of UNSCOPED) {
      expect(live.has(stem), `UNSCOPED names routes/${stem}.ts, which is not a landlord-side route file`).toBe(true)
      expect(why.length, stem).toBeGreaterThan(40)
    }
  })

  it('the scan sees the routes at all', () => {
    expect(landlordRouteFiles().length).toBeGreaterThan(40)
  })
})
