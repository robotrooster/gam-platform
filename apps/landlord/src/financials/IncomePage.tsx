/**
 * 10/11 (Nic): "incoming income type pools, monthly, daily, electric bill
 * back, etc." Money that arrived, added up by what it was for — by month and by
 * day, with totals. Nothing here names a tenant, a unit or a lease, so the
 * owner can hand it to whoever keeps the books.
 *
 * 10/12 (Nic): Charged, Received and Owed side by side for each type (no
 * switch); the months and days stay the money that arrived.
 *
 * 10/19 (Nic): "i need the books breakdown for september mountain view. it
 * still looks the same for betty she doesnt see any new information... We need
 * to make the books actually display the right way. So that she can see it if
 * she needs to go back to it later."
 *
 * So the rows ARE the lines the books keep: rent by the space it is for (RV
 * long-term rent, Mobile home lot rent, park-owned trailer rent, …), short-term
 * stays apart from long-term, home sales and their interest — the ledger's own
 * split (services/incomePools), not a second set of names invented here. Under
 * it, three things that answer "what was that figure?" without leaving the
 * page:
 *   - RENT BY HOW IT WAS SOLD — the same rent money, cut by cadence (a lease's
 *     own rent, or the nightly / weekly / monthly reservation its lease came
 *     from). Kept, because how a space is sold is real information and this page
 *     used to show only that. Cadence and term are independent, so they read
 *     side by side instead of one inside the other. 10/19 (review): BY MONTH AND
 *     BY DAY as well. The two tables at the foot of the page take their columns
 *     from the rows, so the day the rows became the books' lines the cadence
 *     columns left those tables with them, and "how much nightly stay rent came
 *     in in September?" had no answer here any more. The cadence now has its own
 *     month and day tables inside its own card, where it cannot be read as more
 *     rent on top of the line columns.
 *   - WHAT WAS SOLD AT THE REGISTER — every item, how many went out and what
 *     they sold for, with the strip that ties them to the Register sales
 *     account. September at Mountain View is four propane sales, and that is
 *     now readable here instead of in the POS.
 *   - MONEY FILED AS OTHER MONEY IN — each entry in the words of whoever logged
 *     it, with the plain sentence that a lump cannot be broken down from in
 *     here.
 * Both lists are services/booksTaxSales' own read — the same the Sales & tax
 * page prints, off the same postings — so the two pages cannot tell different
 * stories.
 *
 * One of the shared financial pages: the same bytes in the landlord portal and
 * GAM Books (financials-parity.test.ts). The total is the P&L's income total
 * for the same days and properties (GET /financials/income, Money received).
 */
import { useEffect, useMemo, useState } from 'react'
import { useQuery } from 'react-query'
import {
  MONEY_COLUMN_LABEL, MONEY_COLUMN_NOTE,
  BOOKS_OTHER_INCOME_NOT_ITEMIZABLE_NOTE, BOOKS_SOLD_COUNTER_NOT_METERED_NOTE,
  BOOKS_SALES_TIE_TERMS, BOOKS_SALES_TIE_TERM_LABEL, BOOKS_SALES_TIE_TERM_SIGN,
  type BooksOtherIncomeBreakdown, type BooksSalesBreakdown, type BooksSalesTieTerm,
} from '@gam/shared'
import { finGet } from './adapter'
import {
  useFinancialsScope, usePeriod, periodQuery, money, monthName, dayName, errorWords, count, soldQuantity,
  PropertyPicker, PeriodPicker, PageHead, Notice,
} from './common'

/** `amount` is Received; 10/12: `charged` and `owed` beside it (an older reply sends neither). */
interface PoolRow { key: string; label: string; amount: number; charged?: number; owed?: number }
// A period's pools come as a list (the API camelizes object keys, and a pool key is data).
interface PoolPeriod {
  total: number; depositsHeld: number; pools: Array<{ key: string; amount: number }>
  besideTotal?: PoolRow[]
  // 10/19 (review): the rent this month or day received, by how the space was
  // sold. An older reply sends none, and the cadence tables stay off the page.
  rentSoldAs?: Array<{ key: string; amount: number }>
}
const amountOf = (p: PoolPeriod, key: string): number => p.pools.find(x => x.key === key)?.amount ?? 0
const soldOf = (p: PoolPeriod, key: string): number => (p.rentSoldAs ?? []).find(x => x.key === key)?.amount ?? 0
/** All the lot/space rent of one month or day: its cadence rows added up. */
const rentOf = (p: PoolPeriod): number =>
  Math.round((p.rentSoldAs ?? []).reduce((t, x) => t + x.amount, 0) * 100) / 100
interface IncomeData {
  period: { start: string; end: string }
  pools: PoolRow[]
  total: number
  charged?: number
  owed?: number
  depositsHeld: number
  // 10/11: bank deposits filed as an owner contribution or sale proceeds —
  // money in the bank, not income: listed under the total, never in it.
  besideTotal?: PoolRow[]
  months: Array<{ month: string } & PoolPeriod>
  days: Array<{ day: string } & PoolPeriod>
  // 10/19: the rows are the books' own lines (the company's reports read the
  // ledger). An older reply, or a company whose books are not live, sends none
  // of the four below and the page reads exactly as it did.
  itemized?: boolean
  rentSoldAs?: PoolRow[]
  register?: BooksSalesBreakdown
  otherMoneyIn?: BooksOtherIncomeBreakdown
}

/** A bridge term with the sign it carries ("− $5.00"), so the strip reads as the arithmetic it is. */
function signed(term: BooksSalesTieTerm, amount: number): string {
  if (BOOKS_SALES_TIE_TERM_SIGN[term] !== -1) return money(amount)
  return amount === 0 ? money(0) : `− ${money(Math.abs(amount))}`
}

/**
 * 10/19 (review): the bold bottom line of the register strip is the Register
 * sales ACCOUNT over these days. On the Sales & tax page that account is the
 * only thing the table is about, so the shared words read right there. Here the
 * strip sits under a table that splits that same account by what the money was
 * for — a sale that paid toward a stay is Stays and pay links — so September at
 * Mountain View printed "Register sales in the books $137.28" under rows of
 * $124.08 and $13.20 and matched neither of them, and October printed $413.94
 * over a Register sales row of $250.77. It names the account it is instead, so
 * nobody hunts the page for a row that was never going to be there.
 */
const REGISTER_ACCOUNT_LABEL = 'The Register sales account over these days'
const tieTermLabel = (t: BooksSalesTieTerm): string =>
  t === 'posted' ? REGISTER_ACCOUNT_LABEL : BOOKS_SALES_TIE_TERM_LABEL[t]

export function IncomePage() {
  const { data: scope, error: scopeError } = useFinancialsScope()
  const [propertyId, setPropertyId] = useState('')
  const [period, setPeriod] = usePeriod('this_month')
  const { data, isLoading, error } = useQuery<IncomeData>(
    ['financials-income', period.from, period.to, propertyId],
    () => finGet<IncomeData>(`/financials/income?${periodQuery(period, propertyId)}`),
    { keepPreviousData: true },
  )
  const pools = data?.pools ?? []
  const [dayMonth, setDayMonth] = useState('')
  const monthKeys = useMemo(() => (data?.months ?? []).map(m => m.month), [data])
  useEffect(() => {
    if (!monthKeys.includes(dayMonth)) setDayMonth(monthKeys[monthKeys.length - 1] ?? '')
  }, [monthKeys, dayMonth])
  const days = (data?.days ?? []).filter(d => d.day.startsWith(dayMonth))
  const biggest = Math.max(1, ...pools.map(p => Math.abs(p.amount)))
  // The month and day tables are the money that arrived: one column per type that had any.
  const receivedPools = pools.filter(p => p.amount !== 0)
  // 10/19: the rent cut the other way, what was sold, and the lumps.
  const soldAs = data?.rentSoldAs ?? []
  // 10/19 (review): one column per way the rent was sold that took any money,
  // so the cadence tables match the Received column of the card they sit in.
  const soldColumns = soldAs.filter(r => r.amount !== 0)
  const rentDays = days.filter(d => rentOf(d) !== 0)
  const soldCategories = data?.register?.categories ?? []
  const tie = data?.register?.tie
  const otherMoneyIn = data?.otherMoneyIn

  return (
    <div className="fin">
      <PageHead title="Money in"
        subtitle="What was received, charged and owed, by what it was for — and the money that arrived by month and by day." />
      {scopeError ? <Notice>{errorWords(scopeError, 'Could not load your books.')}</Notice> : null}
      <div className="fin-controls">
        <PropertyPicker value={propertyId} onChange={setPropertyId} properties={scope?.properties ?? []} />
        <PeriodPicker value={period} onChange={setPeriod} />
      </div>

      {error ? <Notice>{errorWords(error, 'Could not load money in. Try again in a moment.')}</Notice> : null}

      <div className="fin-kpis">
        {/* 10/12 (Nic, L2): Received leads, then Charged, then Owed. */}
        <div className="fin-kpi">
          <div className="fin-kpi-label">{MONEY_COLUMN_LABEL.received}</div>
          <div className="fin-kpi-value fin-in">{isLoading && !data ? '…' : money(data?.total ?? 0)}</div>
          <div className="fin-kpi-sub">{dayName(period.from)} – {dayName(period.to)}</div>
        </div>
        <div className="fin-kpi">
          <div className="fin-kpi-label">{MONEY_COLUMN_LABEL.charged}</div>
          <div className="fin-kpi-value">{isLoading && !data ? '…' : money(data?.charged ?? 0)}</div>
          <div className="fin-kpi-sub">{MONEY_COLUMN_NOTE.charged}</div>
        </div>
        <div className="fin-kpi">
          <div className="fin-kpi-label">{MONEY_COLUMN_LABEL.owed}</div>
          <div className="fin-kpi-value">{isLoading && !data ? '…' : money(data?.owed ?? 0)}</div>
          <div className="fin-kpi-sub">{MONEY_COLUMN_NOTE.owed}</div>
        </div>
        <div className="fin-kpi">
          <div className="fin-kpi-label">Deposits received</div>
          <div className="fin-kpi-value">{money(data?.depositsHeld ?? 0)}</div>
          <div className="fin-kpi-sub">Held for tenants — never income, not in the total</div>
        </div>
      </div>
      {/* 10/12 (Nic): no basis switch — what Received counts, in the shared words. */}
      <p className="fin-muted" style={{ margin: '-6px 0 16px' }}>{MONEY_COLUMN_NOTE.received}</p>

      <div className="card fin-card">
        <div className="fin-card-head">
          <span className="fin-card-title">By type</span>
          {/* 10/19 (Nic): say where the rows come from, so a figure can be taken back to an account. */}
          {data?.itemized ? (
            <span className="fin-card-note">
              Every line your books keep: rent by the space it is for, short-term stays apart from long-term.
            </span>
          ) : null}
        </div>
        {pools.length === 0 && (data?.besideTotal ?? []).length === 0 ? (
          <div className="fin-empty">{isLoading ? 'Loading…' : 'No money arrived and nothing was charged in these days.'}</div>
        ) : (
          <table className="data-table">
            <thead><tr>
              <th>Type</th>
              <th className="fin-num">{MONEY_COLUMN_LABEL.received}</th>
              <th className="fin-num">{MONEY_COLUMN_LABEL.charged}</th>
              <th className="fin-num">{MONEY_COLUMN_LABEL.owed}</th>
              <th className="fin-num">Share received</th><th></th>
            </tr></thead>
            <tbody>
              {pools.map(p => (
                <tr key={p.key}>
                  <td>{p.label}</td>
                  <td className="fin-num">{money(p.amount)}</td>
                  <td className="fin-num">{money(p.charged ?? 0)}</td>
                  <td className="fin-num">{money(p.owed ?? 0)}</td>
                  <td className="fin-num fin-muted">{data && data.total ? `${Math.round((p.amount / data.total) * 100)}%` : '—'}</td>
                  <td className="fin-bar-cell"><div className="fin-bar" style={{ width: `${Math.max(1, Math.round((Math.abs(p.amount) / biggest) * 100))}%` }} /></td>
                </tr>
              ))}
              <tr className="fin-total">
                <td>Total</td>
                <td className="fin-num">{money(data?.total ?? 0)}</td>
                <td className="fin-num">{money(data?.charged ?? 0)}</td>
                <td className="fin-num">{money(data?.owed ?? 0)}</td>
                <td></td><td></td>
              </tr>
              {(data?.besideTotal ?? []).length > 0 && (
                <tr><td colSpan={6} className="fin-muted">Beside the totals, not in them</td></tr>
              )}
              {(data?.besideTotal ?? []).map(b => (
                <tr key={b.key}>
                  <td className="fin-muted">{b.label}</td>
                  <td className="fin-num fin-muted">{money(b.amount)}</td>
                  <td></td><td></td><td></td><td></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ── 10/19: the same rent, by how the space was sold ──────────────── */}
      {soldAs.length ? (
        <div className="card fin-card">
          <div className="fin-card-head">
            <span className="fin-card-title">Rent by how it was sold</span>
            <span className="fin-card-note">
              The same lot/space rent as above, cut by how the space was sold rather than by what it is. A space sold by
              the night can still be rented long-term, so the two readings are side by side, never one inside the other.
            </span>
          </div>
          <table className="data-table">
            <thead><tr>
              <th>Sold as</th>
              <th className="fin-num">{MONEY_COLUMN_LABEL.received}</th>
              <th className="fin-num">{MONEY_COLUMN_LABEL.charged}</th>
              <th className="fin-num">{MONEY_COLUMN_LABEL.owed}</th>
            </tr></thead>
            <tbody>
              {soldAs.map(r => (
                <tr key={r.key}>
                  <td>{r.label}</td>
                  <td className="fin-num">{money(r.amount)}</td>
                  <td className="fin-num">{money(r.charged ?? 0)}</td>
                  <td className="fin-num">{money(r.owed ?? 0)}</td>
                </tr>
              ))}
              <tr className="fin-total">
                <td>All lot/space rent</td>
                <td className="fin-num">{money(soldAs.reduce((t, r) => t + r.amount, 0))}</td>
                <td className="fin-num">{money(soldAs.reduce((t, r) => t + (r.charged ?? 0), 0))}</td>
                <td className="fin-num">{money(soldAs.reduce((t, r) => t + (r.owed ?? 0), 0))}</td>
              </tr>
            </tbody>
          </table>
          {/* 10/19 (review): and the same cut by month and by day, so nightly
              stay rent for one month is a figure on the page again. */}
          {soldColumns.length ? (
            <>
              <div className="fin-card-head"><span className="fin-card-title">Rent received by month</span></div>
              {(data?.months ?? []).length === 0 ? <div className="fin-empty">Nothing yet.</div> : (
                <table className="data-table">
                  <thead><tr>
                    <th>Month</th>
                    {soldColumns.map(c => <th key={c.key} className="fin-num">{c.label}</th>)}
                    <th className="fin-num">All lot/space rent</th>
                  </tr></thead>
                  <tbody>
                    {(data?.months ?? []).map(m => (
                      <tr key={m.month}>
                        <td style={{ whiteSpace: 'nowrap' }}>{monthName(m.month)}</td>
                        {soldColumns.map(c => <td key={c.key} className="fin-num">{soldOf(m, c.key) ? money(soldOf(m, c.key)) : '—'}</td>)}
                        <td className="fin-num" style={{ fontWeight: 700 }}>{money(rentOf(m))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <div className="fin-card-head">
                <span className="fin-card-title">Rent received by day</span>
                {monthKeys.length > 1 && (
                  <select className="form-input fin-select" value={dayMonth} onChange={e => setDayMonth(e.target.value)}>
                    {monthKeys.map(k => <option key={k} value={k}>{monthName(k)}</option>)}
                  </select>
                )}
              </div>
              {rentDays.length === 0 ? <div className="fin-empty">No rent arrived on any day of this month.</div> : (
                <table className="data-table">
                  <thead><tr>
                    <th>Day</th>
                    {soldColumns.map(c => <th key={c.key} className="fin-num">{c.label}</th>)}
                    <th className="fin-num">All lot/space rent</th>
                  </tr></thead>
                  <tbody>
                    {rentDays.map(d => (
                      <tr key={d.day}>
                        <td style={{ whiteSpace: 'nowrap' }}>{dayName(d.day)}</td>
                        {soldColumns.map(c => <td key={c.key} className="fin-num">{soldOf(d, c.key) ? money(soldOf(d, c.key)) : '—'}</td>)}
                        <td className="fin-num" style={{ fontWeight: 700 }}>{money(rentOf(d))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          ) : null}
        </div>
      ) : null}

      {/* ── 10/19: what was sold at the register, item by item ───────────── */}
      {soldCategories.length ? (
        <div className="card fin-card">
          <div className="fin-card-head">
            <span className="fin-card-title">What was sold at the register</span>
            <span className="fin-card-note">
              Every item, how many went out and what they sold for before tax. The figure at the bottom is the Register
              sales account itself — a sale that paid toward a stay is counted under Stays and pay links above, so one
              account can cover more than one row of the table.
            </span>
          </div>
          <table className="data-table">
            <thead><tr>
              <th>Item</th>
              <th className="fin-num">Quantity</th>
              <th className="fin-num">Sales</th>
              <th className="fin-num">Sales it was on</th>
            </tr></thead>
            <tbody>
              {soldCategories.map(c => [
                <tr key={`${c.label}-head`} className="fin-total">
                  <td>{c.label}</td>
                  <td className="fin-num" />
                  <td className="fin-num">{money(c.sales)}</td>
                  <td className="fin-num" />
                </tr>,
                ...c.items.map(i => (
                  <tr key={`${c.label}-${i.name}`}>
                    <td style={{ paddingLeft: 28 }}>{i.name}</td>
                    <td className="fin-num">{soldQuantity(i.qty, i.unit)}</td>
                    <td className="fin-num">{money(i.sales)}</td>
                    <td className="fin-num fin-muted">{count(i.salesCount)}</td>
                  </tr>
                )),
              ])}
              {/* How the item lines become the figure the books hold: only the
                  terms that moved, and the account's own figure last. */}
              {tie ? BOOKS_SALES_TIE_TERMS.filter(t => t === 'posted' || t === 'itemLines' || tie[t] !== 0).map(t => (
                <tr key={t} className={t === 'posted' ? 'fin-total' : undefined}>
                  <td className={t === 'posted' ? undefined : 'fin-muted'}>{tieTermLabel(t)}</td>
                  <td className="fin-num" />
                  <td className="fin-num">{signed(t, tie[t])}</td>
                  <td className="fin-num" />
                </tr>
              )) : null}
              {tie?.difference ? (
                <tr>
                  <td className="fin-out">
                    Unexplained difference — tell GAM: the item lines and the Register sales account should always agree.
                  </td>
                  <td className="fin-num" />
                  <td className="fin-num fin-out">{money(tie.difference)}</td>
                  <td className="fin-num" />
                </tr>
              ) : null}
            </tbody>
          </table>
          {/* 10/19 (Nic): a company may file counter propane under its own
              "Utilities" category. GAM does not rename its data — and does not
              let the page imply a bottle sold over the counter is a metered
              utility bill either. */}
          <p className="fin-muted" style={{ padding: '0 16px 14px' }}>{BOOKS_SOLD_COUNTER_NOT_METERED_NOTE}</p>
        </div>
      ) : null}

      {/* ── 10/19: money filed as other money in, in its own words ───────── */}
      {otherMoneyIn && otherMoneyIn.rows.length ? (
        <div className="card fin-card">
          <div className="fin-card-head">
            <span className="fin-card-title">Money filed as other money in</span>
            <span className="fin-card-note">
              Money logged rather than rung up — what each entry said it was, and who it came from.
            </span>
          </div>
          <table className="data-table">
            <thead><tr>
              <th>Filed under</th>
              <th>What the record said</th>
              <th>From</th>
              <th>Account it is in</th>
              <th className="fin-num">Amount</th>
              <th className="fin-num">Entries</th>
            </tr></thead>
            <tbody>
              {otherMoneyIn.rows.map(r => (
                <tr key={`${r.accountCode}|${r.category ?? ''}|${r.description ?? ''}`}>
                  <td>{r.label}</td>
                  <td>{r.description ?? '—'}</td>
                  <td>{r.payer ?? '—'}</td>
                  <td>{r.accountCode} {r.accountName}</td>
                  <td className="fin-num">{money(r.amount)}</td>
                  <td className="fin-num fin-muted">{count(r.records)}</td>
                </tr>
              ))}
              <tr className="fin-total">
                <td>Total</td>
                <td /><td /><td />
                <td className="fin-num">{money(otherMoneyIn.total)}</td>
                <td className="fin-num" />
              </tr>
            </tbody>
          </table>
          {otherMoneyIn.noTaxSplit ? (
            <p className="fin-muted" style={{ padding: '0 16px 14px' }}>
              {money(otherMoneyIn.noTaxSplit)} of this: {BOOKS_OTHER_INCOME_NOT_ITEMIZABLE_NOTE}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="card fin-card">
        <div className="fin-card-head"><span className="fin-card-title">{MONEY_COLUMN_LABEL.received} by month</span></div>
        {(data?.months ?? []).length === 0 ? <div className="fin-empty">Nothing yet.</div> : (
          <table className="data-table">
            <thead><tr>
              <th>Month</th>
              {receivedPools.map(p => <th key={p.key} className="fin-num">{p.label}</th>)}
              <th className="fin-num">Total</th>
            </tr></thead>
            <tbody>
              {(data?.months ?? []).map(m => (
                <tr key={m.month}>
                  <td style={{ whiteSpace: 'nowrap' }}>{monthName(m.month)}</td>
                  {receivedPools.map(p => <td key={p.key} className="fin-num">{amountOf(m, p.key) ? money(amountOf(m, p.key)) : '—'}</td>)}
                  <td className="fin-num" style={{ fontWeight: 700 }}>{money(m.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card fin-card">
        <div className="fin-card-head">
          <span className="fin-card-title">{MONEY_COLUMN_LABEL.received} by day</span>
          {monthKeys.length > 1 && (
            <select className="form-input fin-select" value={dayMonth} onChange={e => setDayMonth(e.target.value)}>
              {monthKeys.map(k => <option key={k} value={k}>{monthName(k)}</option>)}
            </select>
          )}
        </div>
        {days.length === 0 ? <div className="fin-empty">Nothing yet.</div> : (
          <table className="data-table">
            <thead><tr>
              <th>Day</th>
              {receivedPools.map(p => <th key={p.key} className="fin-num">{p.label}</th>)}
              <th className="fin-num">Total</th>
            </tr></thead>
            <tbody>
              {days.map(d => (
                <tr key={d.day}>
                  <td style={{ whiteSpace: 'nowrap' }}>{dayName(d.day)}</td>
                  {receivedPools.map(p => <td key={p.key} className="fin-num">{amountOf(d, p.key) ? money(amountOf(d, p.key)) : '—'}</td>)}
                  <td className="fin-num" style={{ fontWeight: 700 }}>{money(d.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
