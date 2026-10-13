/**
 * 10/11 (Nic) — WHAT A BOOKKEEPER'S SESSION MAY REACH.
 *
 *   "I need to invite somebody to be a bookkeeper for the Mountain View
 *    property. They don't need to see anything with Oak Park. They don't
 *    necessarily need to see anything to do with non-bookkeeping related stuff.
 *    They just need to see the financials, money coming in, money going out,
 *    maintenance... the maintenance costs. ... They don't necessarily need to
 *    see all your sensitive lease data..."
 *
 * And later the same day, on names: "let's probably have it actually just show
 * their names." Tenant NAMES are allowed wherever the books need them — who
 * paid is half of keeping the books. Contact and identity details are not:
 * email, phone, mailing address, date of birth, SSN, driver's license, vehicle
 * and tenant user ids stay out, and so do lease text, documents, screening,
 * maintenance request text and messages (those routes are not on the list).
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
 *   - the GAM Books ledger (/api/books/*), its rent roll included. Books
 *     responses do not pass the scrub below (payroll names and pays the
 *     company's own staff), so a Books route a bookkeeper reads leaves contact
 *     details out itself — the rent roll does (routes/books.ts).
 *   - the shared financial pages' own API (/api/financials/*): money in by
 *     type, maintenance costs, bank activity, payouts — read only
 *   - expenses: list, add, edit, remove, attach a receipt, open a receipt.
 *     10/12 (Nic, L5/L19): the company's categories, and paying a bill
 *     (recording or taking back a payment) — money going out. 10/12 (Nic,
 *     ledger decision 2): "Full bookkeeping … never tenant-account actions …
 *     One level" — any expense on a property they keep, not only their own,
 *     and removing one (design §11 "Voiding expenses"); routes/expenses checks
 *     each row against their company and properties.
 *   - 10/12 (Nic, L19): with the company-wide box, the bank lines: file, match
 *     and undo money going out; money coming in only as the owner chose for
 *     them (any, only after "Not rent", or never). Never a tenant's payment.
 *     10/13 (Nic): marking a deposit "Not rent" (and taking the mark back) is
 *     theirs too: "owner + bookkeeper (not front-desk staff)".
 *   - 10/13 (Nic): "Bookkeepers SEE the Payments and Rent Roll pages,
 *     read-only" — GET /api/balances/rent-roll/(properties|open-month|history),
 *     their property boxes narrowing each (routes/balances). The pages carry
 *     what Nic asked them to show: each row's charges (what each was for,
 *     invoiced, paid, owed) and payments (day, amount, method, a check or
 *     deposit number), stays and the register's money — names, spaces and
 *     money, scrubbed of contact details. Never the other /api/balances
 *     routes (who owes with phone and email, GET /balances/:tenantId/invoices,
 *     the Payments ledger GET /balances/payments-by-month), and never
 *     recording a payment, a credit or an import (those routes stay refused).
 *   - the P&L reports the shared Reports page reads (overview, by property,
 *     a property's detail, a month's P&L). Never the owner statement, the tax
 *     summary or the 1099 work-trade summary (they carry the company's own
 *     banking and tax identity and tenants' emails), never the custom report
 *     engine (it groups and filters on anything a lease row holds).
 *   - 10/12 (Nic): the monthly property report, on screen (and its PDF, the
 *     same page printed) — reachable here for every bookkeeper, opened only
 *     to one whose owner ticked "Sees the monthly property report on screen"
 *     (bookkeeperHasPerm below: the route's own permission is theirs only with
 *     the box; routes/reports refuses it again without). Never its recipient
 *     list (the owner's alone).
 *   - the portal chrome: the theme and GAM's announcements
 *
 * Every allowed route ALSO checks the row against the bookkeeper's company and
 * properties (requireAuth puts both on req.user), and every response a
 * bookkeeper reads through these routes (outside their sign-in and Books)
 * passes scrubPersonFields on the way out: names, units and money pass, and an
 * email, phone number, address or other identity detail that reaches a
 * response by a join nobody thought about still never reaches the screen.
 */

/**
 * The sentence every refused request answers with. 10/12 (Nic): payroll and
 * the bank are the company-wide box's, so they are named as that.
 */
export const BOOKKEEPER_REFUSAL =
  'Bookkeepers see money in and who paid it, money out, receipts and maintenance costs, and with the company-wide box the bank account, payouts and payroll. This part of GAM is not included.'

type Rule = { method: string; test: RegExp }

const RULES: Rule[] = [
  // Their own sign-in, password, two-step code and sign-out.
  { method: '*',      test: /^\/api\/auth(\/|$)/ },
  // The shared financial pages (read only — the router has no writes).
  { method: 'GET',    test: /^\/api\/financials(\/|$)/ },
  // Expenses: look, add, edit, attach and open receipts. 10/12 (Nic, ledger
  // decision 2): and remove (void, kept on record) — full bookkeeping.
  { method: 'GET',    test: /^\/api\/expenses\/?$/ },
  { method: 'POST',   test: /^\/api\/expenses\/?$/ },
  { method: 'PATCH',  test: /^\/api\/expenses\/[0-9a-f-]{36}\/?$/i },
  { method: 'POST',   test: /^\/api\/expenses\/[0-9a-f-]{36}\/void\/?$/i },
  { method: 'POST',   test: /^\/api\/expenses\/[0-9a-f-]{36}\/receipt\/?$/i },
  { method: 'GET',    test: /^\/api\/expenses\/receipt-files\/[^/]+$/ },
  // 10/12 (Nic, L5): "just let bookkeeper/landlord create custom labels or
  // categories" — the company's categories, the Expenses form's choices, what
  // was paid on a bill (money going out is open to them, Nic L19) and a
  // completed repair's bill (Nic L6). Each route checks the row against their
  // company and properties.
  { method: 'GET',    test: /^\/api\/expenses\/(options|categories)\/?$/ },
  { method: 'POST',   test: /^\/api\/expenses\/categories\/?$/ },
  { method: 'PATCH',  test: /^\/api\/expenses\/categories\/[0-9a-f-]{36}\/?$/i },
  { method: 'POST',   test: /^\/api\/expenses\/[0-9a-f-]{36}\/payments\/?$/i },
  { method: 'POST',   test: /^\/api\/expenses\/[0-9a-f-]{36}\/payments\/[0-9a-f-]{36}\/void\/?$/i },
  { method: 'POST',   test: /^\/api\/expenses\/repairs\/[0-9a-f-]{36}\/bill\/?$/i },
  // 10/12 (Nic, L19, design §11): bank lines — money going out is theirs to
  // file, match and undo with the bank (the company-wide box); money coming
  // in only as the owner chose for them (routes/bankFeed checks both).
  { method: 'GET',    test: /^\/api\/bank-feed\/(connections|transactions)\/?$/ },
  { method: 'GET',    test: /^\/api\/bank-feed\/transactions\/[0-9a-f-]{36}\/matches\/?$/i },
  { method: 'POST',   test: /^\/api\/bank-feed\/transactions\/[0-9a-f-]{36}\/(categorize|split|split\/undo|undo-filing|ignore|match-expenses|match-record)\/?$/i },
  // 10/13 (Nic): "Bank deposit 'Not rent': owner + bookkeeper (not front-desk
  // staff)" — marking a deposit "Not rent", and its Undo. routes/bankFeed
  // holds them to the company-wide box (requireBankFiler) and the row's company.
  { method: 'POST',   test: /^\/api\/bank-feed\/deposits\/[0-9a-f-]{36}\/not-rent(\/undo)?\/?$/i },
  // 10/13 (Nic): "Bookkeepers SEE the Payments and Rent Roll pages,
  // read-only." The property picker, the open month (the Payments page) and
  // the history (the Rent Roll) — GETs only, nothing on them writes.
  // routes/balances narrows each to their property boxes, keeps the clean cut
  // at a sale, sends no desk window and follows the lease-dates box; every
  // reply passes the contact scrub (names, spaces and money only). The rows'
  // charges and payments ride on the open month (the page shows them); the
  // rest of /api/balances — who owes with contact details, a tenant's
  // invoices (/balances/:tenantId/invoices), the Payments ledger — stays
  // refused.
  { method: 'GET',    test: /^\/api\/balances\/rent-roll\/(properties|open-month|history)\/?$/ },
  // The P&L reports.
  { method: 'GET',    test: /^\/api\/reports\/(summary|monthly-pl|property-pl|site-downtime|property-detail)\/?$/ },
  // 10/12 (Nic): the monthly property report, with the owner's box (see the header).
  { method: 'GET',    test: /^\/api\/reports\/monthly-report(\/pdf)?\/?$/ },
  // Portal chrome that names nobody.
  { method: 'GET',    test: /^\/api\/landlords\/theme\/?$/ },
  { method: 'GET',    test: /^\/api\/announcements\/?$/ },
]

/**
 * GAM Books' ledger is theirs, the rent roll included. 10/11 (Nic): the rent
 * roll was refused for naming every tenant; names are allowed now, and the
 * route leaves the tenant's email, ACH and On-Time Pay out of a bookkeeper's
 * rows itself (Books responses do not pass the scrub).
 */
const BOOKS = /^\/api\/books(\/|$)/

export function isBookkeeperRequestAllowed(method: string, url: string): boolean {
  const path = (url || '').split('?')[0]
  const m = method.toUpperCase()
  if (BOOKS.test(path)) return true
  return RULES.some(r => (r.method === '*' || r.method === m) && r.test.test(path))
}

/**
 * Responses that pass through the contact scrub. Their own sign-in (the portal
 * shows the bookkeeper their own email) and the Books ledger (payroll keeps the
 * company's own employees and contractors on file) are left alone; everything
 * else a bookkeeper can reach is about money and has no business carrying how
 * to reach a person.
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
  'payments.view_all',      // the P&L reports' gate, and (10/13) the Payments page and the Rent Roll
  'reports.tab.overview',
  'reports.tab.property',
])

/**
 * 10/12 (Nic): the permission keys a bookkeeper holds only with an owner's
 * box on their scope row — "Sees the monthly property report on screen" holds
 * the Monthly report tab's key. Read off the request's scope (requireAuth puts
 * it there); a bare pass without it holds none of them.
 */
const BOOKKEEPER_BOX_PERMS: Record<string, (scope: { seesMonthlyReport?: boolean }) => boolean> = {
  'reports.tab.monthly': scope => scope.seesMonthlyReport === true,
}

/** Does a bookkeeper with this request scope hold this permission key? */
export function bookkeeperHasPerm(scope: { seesMonthlyReport?: boolean } | null | undefined, key: string): boolean {
  if (BOOKKEEPER_GRANTED_PERMS.has(key)) return true
  const box = BOOKKEEPER_BOX_PERMS[key]
  return !!box && !!scope && box(scope)
}

/**
 * 10/11 (Nic): keys that carry a person's contact or identity details — what a
 * bookkeeper never needs to keep the books. Matched case-insensitively on the
 * key with underscores removed, so tenant_email, tenantEmail and TENANTEMAIL
 * are one rule, and by ending, so a join nobody thought about (office_email,
 * guest_phone, lease_signing_email, mailing_address) is caught too.
 *
 * NOT here, on purpose: names (tenantName, firstName, guestName, payerName…),
 * and tenantId and leaseId. Who paid is half of keeping the books, and the ids
 * only group one person's payments — every route they would open (tenants,
 * leases) is refused above. Containers (tenants, residents, occupants) pass
 * too; the walk takes the contact keys out of what is inside them.
 */
const CONTACT_KEYS = new Set([
  'tenantuserid', 'primarytenantuserid',
  'dob', 'birthdate', 'birthday',
  'plate', 'plateorid', 'platestate', 'plateexpirydate',
  'street1', 'street2', 'zip', 'zipcode', 'postalcode', 'vin',
])
// 10/11: widened after a direct run of the scrub let street1, zip,
// business_zip, vin, rv_plate, tenant_dob and phone_e164 through. "plate" as an
// ending skips "template" (an email or lease template is not a license plate).
const CONTACT_ENDINGS = /(email|emails|phone|phones|phonenumber|phonee164|address|addresses|dateofbirth|dob|street1|street2|zip|zipcode|postalcode|vin|(?<!tem)plate)$/
const CONTACT_STARTS = /^(ssn|vehicle|mailing)/  // ssn, ssn_last4; vehicle, vehicle_make, vehicles; mailing_city
// license: drivers_license, license_plate, license_number. ssn only at the
// start of a key or after a person (tenant_ssn_last4, guest_ssn), never inside
// a word: business_name holds the letters s-s-n. emailverify / pendingemail:
// the tokens that confirm an address (email_verify_token, pending_email_token).
const CONTACT_ANYWHERE = /license|(^|tenant|primary|guest|cotenant|applicant|occupant)ssn|vehicle|emailverify|pendingemail|addressline/

function isContactKey(k: string): boolean {
  const key = k.replace(/_/g, '').toLowerCase()
  return CONTACT_KEYS.has(key) || CONTACT_ENDINGS.test(key) || CONTACT_STARTS.test(key) || CONTACT_ANYWHERE.test(key)
}

/**
 * A deep copy of `body` with every contact and identity key removed, at any
 * depth. Names, units, ids and money pass (see CONTACT_KEYS above).
 */
export function scrubPersonFields<T>(body: T): T {
  const walk = (v: any): any => {
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object' && !(v instanceof Date) && !Buffer.isBuffer(v)) {
      const out: Record<string, any> = {}
      for (const [k, val] of Object.entries(v)) {
        if (isContactKey(k)) continue
        out[k] = walk(val)
      }
      return out
    }
    return v
  }
  return walk(body)
}
