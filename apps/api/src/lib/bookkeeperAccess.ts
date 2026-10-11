/**
 * 10/11 (Nic) — WHAT A BOOKKEEPER'S SESSION MAY REACH.
 *
 *   "I need to invite somebody to be a bookkeeper for the Mountain View
 *    property. They don't need to see anything with Oak Park. They don't
 *    necessarily need to see anything to do with non-bookkeeping related stuff.
 *    They just need to see the financials, money coming in, money going out,
 *    maintenance... the maintenance costs. ... They don't necessarily need to
 *    see all your sensitive lease data... maybe not even necessarily people's
 *    names."
 *
 * A bookkeeper is a TEAM role (lib/landlordScope TEAM_ROLES), so before this a
 * bookkeeper's session resolved a landlord scope and could walk into any route
 * that trusted one: tenants, leases, documents, messages, the schedule. Fixing
 * those one at a time cannot hold — there are hundreds and the next one added
 * is the leak. So the rule is the cashier's (lib/posLock): DENY BY DEFAULT.
 * requireAuth refuses every request a bookkeeper's session makes unless it is
 * on the short list below. Adding a line here is somebody deciding that a
 * bookkeeper may see one more thing.
 *
 * What is on it, and why:
 *   - their own sign-in (/api/auth/*): who am I, sign out, change password
 *   - the GAM Books ledger (/api/books/*) as it was — except its rent roll,
 *     which names every tenant
 *   - the shared financial pages' own API (/api/financials/*): money in by
 *     type, maintenance costs, bank activity, payouts — read only
 *   - expenses: list, add, edit their own, attach a receipt, open a receipt.
 *     Never remove one.
 *   - the P&L reports the shared Reports page reads (overview, by property,
 *     a property's detail, a month's P&L). Never the owner statement, the tax
 *     summary or the 1099 work-trade summary (they list people), never the
 *     custom report engine (it can group by resident).
 *   - the portal chrome that names no one: the theme and GAM's announcements
 *
 * Every allowed route ALSO checks the row against the bookkeeper's company and
 * properties (requireAuth puts both on req.user), and every response a
 * bookkeeper reads through these routes passes scrubPersonFields on the way
 * out, so a name that reaches a response by a join nobody thought about still
 * never reaches the screen.
 */

/** The sentence every refused request answers with. */
export const BOOKKEEPER_REFUSAL =
  'Bookkeepers see money in, money out, receipts and maintenance costs. This part of GAM is not included.'

type Rule = { method: string; test: RegExp }

const RULES: Rule[] = [
  // Their own sign-in, password, two-step code and sign-out.
  { method: '*',      test: /^\/api\/auth(\/|$)/ },
  // The shared financial pages (read only — the router has no writes).
  { method: 'GET',    test: /^\/api\/financials(\/|$)/ },
  // Expenses: look, add, edit their own, attach and open receipts.
  { method: 'GET',    test: /^\/api\/expenses\/?$/ },
  { method: 'POST',   test: /^\/api\/expenses\/?$/ },
  { method: 'PATCH',  test: /^\/api\/expenses\/[0-9a-f-]{36}\/?$/i },
  { method: 'POST',   test: /^\/api\/expenses\/[0-9a-f-]{36}\/receipt\/?$/i },
  { method: 'GET',    test: /^\/api\/expenses\/receipt-files\/[^/]+$/ },
  // The P&L reports.
  { method: 'GET',    test: /^\/api\/reports\/(summary|monthly-pl|property-pl|site-downtime|property-detail)\/?$/ },
  // Portal chrome that names nobody.
  { method: 'GET',    test: /^\/api\/landlords\/theme\/?$/ },
  { method: 'GET',    test: /^\/api\/announcements\/?$/ },
]

/** GAM Books' ledger is theirs as it was, all but the rent roll. */
const BOOKS = /^\/api\/books(\/|$)/
const BOOKS_REFUSED = /^\/api\/books\/rent-roll(\/|$)/

export function isBookkeeperRequestAllowed(method: string, url: string): boolean {
  const path = (url || '').split('?')[0]
  const m = method.toUpperCase()
  if (BOOKS.test(path)) return !BOOKS_REFUSED.test(path)
  return RULES.some(r => (r.method === '*' || r.method === m) && r.test.test(path))
}

/**
 * Responses that pass through the person scrub. Their own sign-in (the portal
 * shows the bookkeeper their own name) and the Books ledger (payroll names the
 * bookkeeper's own employees and contractors) are left alone; everything else a
 * bookkeeper can reach is about money and has no business carrying a person.
 */
export function bookkeeperResponseIsScrubbed(url: string): boolean {
  const path = (url || '').split('?')[0]
  return !/^\/api\/auth(\/|$)/.test(path) && !BOOKS.test(path)
}

/**
 * The permission keys a bookkeeper holds on the routes above, so the routes'
 * own requirePerm gates (written for staff) let them through. Holding a key
 * here opens nothing on its own: the allowlist decides which routes are
 * reachable at all.
 */
export const BOOKKEEPER_GRANTED_PERMS: ReadonlySet<string> = new Set([
  'payments.view_all',      // the P&L reports' gate
  'reports.tab.overview',
  'reports.tab.property',
])

/**
 * Keys that name or reach a person. Matched case-insensitively against the key
 * with underscores removed, so tenant_first, tenantFirst and TENANTFIRST are
 * one rule. `name` alone is NOT here — a property, a category and a company
 * all have one.
 */
const PERSON_KEYS = new Set([
  'tenantname', 'tenantfirst', 'tenantlast', 'tenantfirstname', 'tenantlastname',
  'tenantemail', 'tenantphone', 'tenantid', 'tenantuserid',
  'firstname', 'lastname', 'fullname', 'email', 'phone', 'phonenumber',
  'primaryfirstname', 'primarylastname', 'primaryemail', 'primaryphone',
  'guestname', 'guestemail', 'guestphone', 'guestfirstname', 'guestlastname',
  'payername', 'payeremail', 'customername', 'customeremail', 'customerphone',
  'occupantname', 'occupants', 'residentname', 'residents', 'tenants',
  'leaseid', 'leasetenants', 'cotenants',
])

function isPersonKey(k: string): boolean {
  return PERSON_KEYS.has(k.replace(/_/g, '').toLowerCase())
}

/** A deep copy of `body` with every person-naming key removed. */
export function scrubPersonFields<T>(body: T): T {
  const walk = (v: any): any => {
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object' && !(v instanceof Date) && !Buffer.isBuffer(v)) {
      const out: Record<string, any> = {}
      for (const [k, val] of Object.entries(v)) {
        if (isPersonKey(k)) continue
        out[k] = walk(val)
      }
      return out
    }
    return v
  }
  return walk(body)
}
