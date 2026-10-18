/**
 * 10/17 (Nic) — THE BOOKS SAY WHAT WAS SOLD AND WHAT TAX WAS COLLECTED
 *
 *   Nic, 10/17: "There is things listed as other income or just sales. Sales
 *   need to be broken down separately because we collect lodging tax for
 *   short-term stays and we collect sales tax on propane for the transaction
 *   privilege tax. Those need to be itemized so we can file that tax to the
 *   right departments and pay that correctly."
 *
 * Registered on the Books router (routes/books.ts), beside the ledger reports:
 *
 *   GET /books/tax/sales-breakdown   every item sold in the period with its
 *                                    quantity and its dollars, grouped by
 *                                    register category and bridged to what the
 *                                    books posted to Register sales; the money
 *                                    FILED as other income instead of rung up,
 *                                    named by the category it was filed under
 *                                    and the words whoever logged it used (the
 *                                    other half Nic named — at Mountain View
 *                                    the Square card sales from before the GAM
 *                                    card reader); and each named tax with the
 *                                    sales it was charged on, the rate, what
 *                                    was collected, what has been sent to the
 *                                    agency and what is still sitting in its
 *                                    liability account.
 *                                    ?startDate / ?endDate (this calendar year
 *                                    to today, Phoenix, by default) and
 *                                    ?property=<id> for one property.
 *
 * WHO SEES IT. It is a company document, like the tax summary and the Books
 * P&L: a team member assigned to some properties is refused it in plain words,
 * and a bookkeeper opens it with the company-wide box or the whole-company
 * ledger box (refuseScopedStaff, BK1). A bookkeeper's own property cut still
 * applies to the figures (BK2, companyReportPropertyScope), so a report she
 * opens never shows a property that is not hers.
 *
 * It reads the LEDGER, so a company whose books are not live yet gets
 * { live: false, reason } — the same answer the trial balance and general
 * ledger give — rather than a page of zeros that looks like "nothing sold".
 *
 * Read-only: nothing here writes (no agent action needed).
 */
import type { Request, Router } from 'express'
import { requireBooksRead } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { todayIn } from '../lib/timezone'
import { ledgerReportsLive, ledgerNotLiveReason, type LedgerScope } from '../services/ledgerReports'
import { booksSalesAndTax } from '../services/booksTaxSales'
import { refuseScopedStaff } from './reports'
import type { PropertyCutoff } from '../lib/bookkeeperScope'

export interface BooksTaxSalesDeps {
  /** routes/books ownerScope: the company whose books are open (null id = an admin's every landlord). */
  ownerScope: (user: any) => { col: 'landlord_id' | 'business_id'; id: string | null }
  /** routes/books companyReportPropertyScope: a bookkeeper's property money in a company report (BK2). */
  companyReportPropertyScope: (user: any) => Promise<{ propertyIds: string[] | null; cutoffs: PropertyCutoff[] }>
}

const DAY = /^\d{4}-\d{2}-\d{2}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The period: ?startDate / ?endDate, this calendar year to today (Phoenix) by default. */
function periodOf(req: Request): { start: string; end: string } {
  const today = todayIn(null)
  const start = String(req.query.startDate ?? `${today.slice(0, 4)}-01-01`)
  const end = String(req.query.endDate ?? today)
  if (!DAY.test(start) || !DAY.test(end)) throw new AppError(400, 'Choose the dates for the breakdown.')
  if (start > end) throw new AppError(400, 'The start date is after the end date.')
  return { start, end }
}

/** "Jan 1, 2026 to Oct 17, 2026" — the period in the words the page prints. */
function periodLabel(start: string, end: string): string {
  const w = (d: string) => {
    const [y, m, dd] = d.split('-').map(Number)
    return new Date(Date.UTC(y, m - 1, dd)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
  }
  return `${w(start)} to ${w(end)}`
}

export function registerBooksTaxSalesRoutes(router: Router, deps: BooksTaxSalesDeps): void {
  router.get('/tax/sales-breakdown', requireBooksRead, async (req, res, next) => {
    try {
      const { col, id } = deps.ownerScope(req.user)
      const landlordId = col === 'landlord_id' && id ? id : null
      if (!landlordId) {
        throw new AppError(400, 'Open one landlord company’s books to see what it sold and what tax it collected.')
      }
      if (!(await ledgerReportsLive([landlordId]))) {
        return res.json({ success: true, data: { live: false, reason: await ledgerNotLiveReason(landlordId) } })
      }
      // A company document: a team member on some properties is refused it, a
      // bookkeeper opens it with the company-wide or whole-company ledger box.
      await refuseScopedStaff(req.user, 'sales and tax breakdown', { ledger: true })
      const { start, end } = periodOf(req)

      // A bookkeeper's own property cut (BK2), narrowed further when the page
      // asks for one property — a lodging tax is filed with the town the site
      // is in, so one property at a time is how the filing is read.
      const sc = await deps.companyReportPropertyScope(req.user)
      let propertyIds: readonly string[] | null = sc.propertyIds
      const asked = typeof req.query.property === 'string' ? req.query.property : null
      if (asked && asked !== 'all') {
        if (!UUID.test(asked)) throw new AppError(400, 'Choose a property.')
        if (propertyIds && !propertyIds.includes(asked)) {
          throw new AppError(403, 'That property is not one you keep the books for.')
        }
        propertyIds = [asked]
      }
      const scope: LedgerScope = { landlordIds: [landlordId], propertyIds, cutoffs: sc.cutoffs }
      const data = await booksSalesAndTax(scope, start, end, periodLabel(start, end))
      res.json({ success: true, data: { live: true, ...data } })
    } catch (e) { next(e) }
  })
}
