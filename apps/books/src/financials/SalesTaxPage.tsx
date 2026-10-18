/**
 * 10/17 (Nic): "There is things listed as other income or just sales. Sales
 * need to be broken down separately because we collect lodging tax for
 * short-term stays and we collect sales tax on propane for the transaction
 * privilege tax. Those need to be itemized so we can file that tax to the
 * right departments and pay that correctly — the landlord needs to be able to
 * do that... we need more breakdown so we can see exactly how much of each
 * item was sold and how much of each tax separated by category was collected.
 * That way it can be forwarded on to the right agencies, or the right amounts
 * logged."
 *
 * Three lists, which download as one spreadsheet because a filing gets
 * attached to a form (GET /books/tax/sales-breakdown):
 *
 *   WHAT WAS SOLD     every item, how many went out, what they sold for,
 *                     grouped by its register category, and a strip showing how
 *                     those lines add up to the figure the books hold.
 *   OTHER MONEY IN    the other half Nic named: money filed as other income
 *                     instead of rung up — at Mountain View, the Square card
 *                     sales from before the GAM card reader — named by the
 *                     category it was filed under and by the words whoever
 *                     logged it used, with the plain warning that a lump
 *                     recorded no tax inside it.
 *   TAX COLLECTED     one line per named tax, with the liability account the
 *                     money is sitting in and what is still to be sent on.
 *
 * The strip under the first list is a RECONCILIATION, not an identity: the item
 * lines are added up from the sales themselves, and the figure beside them is
 * what the books actually credited. They have always agreed; the difference row
 * exists to catch the day they do not.
 *
 * One of the shared financial pages: the same bytes in the landlord portal and
 * GAM Books (financials-parity.test.ts).
 */
import { useState } from 'react'
import { useQuery } from 'react-query'
import {
  BOOKS_OTHER_INCOME_NO_TAX_NOTE,
  BOOKS_SALES_TIE_TERMS, BOOKS_SALES_TIE_TERM_LABEL, BOOKS_SALES_TIE_TERM_NOTE, BOOKS_SALES_TIE_TERM_SIGN,
  RENT_ROLL_STAY_UNITS, RENT_ROLL_STAY_UNIT_LABEL, stayQuantityText,
  type BooksSalesAndTax, type BooksSalesTieTerm, type RentRollStayUnit,
} from '@gam/shared'
import { finGet } from './adapter'
import { StayTaxCard } from './StayTaxCard'
import {
  useFinancialsScope, usePeriod, money, dayName, errorWords, downloadCsv,
  PropertyPicker, PeriodPicker, PageHead, Notice,
} from './common'

/** The answer, or the plain reason this company's books do not carry it yet. */
type Answer = ({ live: true } & BooksSalesAndTax) | { live: false; reason: string | null }

/** 0.066 → "6.6%" (and 0 → "—": the sale recorded no rate). */
function percent(rate: number): string {
  if (!rate) return '—'
  const s = (rate * 100).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
  return `${s}%`
}

/** 10.6 → "10.6", 4 → "4" (gallons and kilowatt-hours come with decimals). */
const count = (n: number): string =>
  Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 3 })

/** Is this what a stay item is sold by (a night, a week, a month)? */
const isStayUnit = (u: string | null): u is RentRollStayUnit =>
  !!u && (RENT_ROLL_STAY_UNITS as readonly string[]).includes(u)

/** How many went out: "3 months" for a stay item, "10.6" for gallons. */
const quantity = (qty: number, unit: string | null): string =>
  isStayUnit(unit) ? stayQuantityText(qty, unit) : count(qty)

/** What a stay item is sold by, in words ("months"); nothing for anything else. */
const soldBy = (unit: string | null): string =>
  isStayUnit(unit) ? RENT_ROLL_STAY_UNIT_LABEL[unit].many : ''

export function SalesTaxPage() {
  const { data: scope, error: scopeError } = useFinancialsScope()
  const [propertyId, setPropertyId] = useState('')
  const [period, setPeriod] = usePeriod('this_month')
  const dates = `startDate=${period.from}&endDate=${period.to}${propertyId ? `&property=${propertyId}` : ''}`
  const { data, isLoading, error } = useQuery<Answer>(
    ['books-sales-tax', period.from, period.to, propertyId],
    () => finGet<Answer>(`/books/tax/sales-breakdown?${dates}`),
    { keepPreviousData: true },
  )
  const live = data && data.live ? data : null
  const sales = live?.sales
  const taxes = live?.taxes
  const tie = sales?.tie
  const other = live?.otherIncome

  /**
   * Both breakdowns in ONE spreadsheet, in the order they read on screen, so it
   * can be attached to a filing whole. Seven columns throughout: the two
   * sections use the ones they need and leave the rest empty.
   */
  const exportSpreadsheet = () => {
    if (!live || !sales || !taxes) return
    const row = (...cells: (string | number)[]): (string | number)[] =>
      [...cells, ...Array(Math.max(0, 7 - cells.length)).fill('')]
    const rows: (string | number)[][] = [row('WHAT WAS SOLD', 'Item', 'Sold by', 'Quantity', 'Sales', 'Sales it was on')]
    for (const c of sales.categories) {
      for (const i of c.items) rows.push(row(c.label, i.name, soldBy(i.unit), i.qty, i.sales, i.salesCount))
      rows.push(row(c.label, 'Category total', '', '', c.sales))
    }
    rows.push(row(''))
    rows.push(row('HOW IT ADDS UP TO THE BOOKS', '', '', '', 'Amount'))
    for (const t of BOOKS_SALES_TIE_TERMS) {
      rows.push(row(BOOKS_SALES_TIE_TERM_LABEL[t], '', '', '', (tie ? tie[t] : 0) * (BOOKS_SALES_TIE_TERM_SIGN[t] === -1 ? -1 : 1)))
    }
    if (tie?.difference) rows.push(row('Unexplained difference', '', '', '', tie.difference))
    if (tie?.returns) rows.push(row('Money given back (Sales returns)', '', '', '', tie.returns))
    if (other && other.rows.length) {
      rows.push(row(''))
      rows.push(row('OTHER MONEY IN', 'Account it is in', 'What the record said', 'From', 'Amount', 'Records'))
      for (const r of other.rows) {
        rows.push(row(r.label, `${r.accountCode} ${r.accountName}`, r.description ?? '', r.payer ?? '', r.amount, r.records))
      }
      rows.push(row('Total', '', '', '', other.total))
      if (other.noTaxSplit) rows.push(row('Logged as a lump with no tax recorded inside it', '', '', '', other.noTaxSplit))
    }
    rows.push(row(''))
    rows.push(row('TAX COLLECTED', 'Account the money is in', 'Rate', 'Taxable sales', 'Collected', 'Sent on', 'Still to send'))
    for (const r of taxes.rows) {
      rows.push(row(r.label, `${r.accountCode} ${r.accountName}`,
        r.rates.length === 1 ? percent(r.rates[0].rate) : r.rates.length ? 'Several' : '—',
        r.rates.length ? r.taxableSales : '—', r.collected, r.paid, r.unpaid))
      if (r.rates.length > 1) {
        for (const x of r.rates) rows.push(row(`${r.label} — at ${percent(x.rate)}`, '', percent(x.rate), x.taxableSales, x.collected))
      }
    }
    rows.push(row('Total', '', '', taxes.totals.taxableSales, taxes.totals.collected, taxes.totals.paid, taxes.totals.unpaid))
    downloadCsv(`sales-and-tax-${live.period.start}-to-${live.period.end}.csv`,
      row(`What was sold and what tax was collected — ${live.period.label}`).map(String), rows)
  }

  return (
    <div className="fin">
      <PageHead title="Sales & tax"
        subtitle="Everything sold, item by item, and each tax collected — what to file, and the account the money is sitting in." />
      {scopeError ? <Notice>{errorWords(scopeError, 'Could not load your books.')}</Notice> : null}
      <div className="fin-controls">
        <PropertyPicker value={propertyId} onChange={setPropertyId} properties={scope?.properties ?? []} />
        <PeriodPicker value={period} onChange={setPeriod} />
        <button type="button" className="btn btn-primary" onClick={exportSpreadsheet} disabled={!live}>
          Export spreadsheet
        </button>
      </div>

      {error ? <Notice>{errorWords(error, 'Could not load the breakdown. Try again in a moment.')}</Notice> : null}
      {data && !data.live ? (
        <Notice>{data.reason || 'This company’s books are not reading the ledger yet, so there is nothing to break down.'}</Notice>
      ) : null}

      {live ? (
        <>
          <div className="fin-kpis">
            <div className="fin-kpi">
              <div className="fin-kpi-label">Sold</div>
              <div className="fin-kpi-value fin-in">{money(tie?.posted ?? 0)}</div>
              <div className="fin-kpi-sub">{dayName(live.period.start)} – {dayName(live.period.end)} · {count(sales?.salesCount ?? 0)} sales</div>
            </div>
            <div className="fin-kpi">
              <div className="fin-kpi-label">Tax collected</div>
              <div className="fin-kpi-value">{money(taxes?.totals.collected ?? 0)}</div>
              <div className="fin-kpi-sub">Charged to customers in these days</div>
            </div>
            <div className="fin-kpi">
              <div className="fin-kpi-label">Still to send on</div>
              <div className="fin-kpi-value fin-out">{money(taxes?.totals.unpaid ?? 0)}</div>
              <div className="fin-kpi-sub">Sitting in the tax accounts at the end of these days</div>
            </div>
            <div className="fin-kpi">
              <div className="fin-kpi-label">Given back</div>
              <div className="fin-kpi-value">{money(tie?.returns ?? 0)}</div>
              <div className="fin-kpi-sub">Refunds and chargebacks — beside the total, never in it</div>
            </div>
          </div>

          {/* ── What was sold ───────────────────────────────────────────── */}
          <div className="card fin-card">
            <div className="fin-card-head">
              <span className="fin-card-title">What was sold</span>
              <span className="fin-card-note">Every item, how many went out and what they sold for before tax.</span>
            </div>
            {!sales || sales.categories.length === 0 ? (
              <div className="fin-empty">{isLoading ? 'Loading…' : 'Nothing was sold at the register in these days.'}</div>
            ) : (
              <table className="data-table">
                <thead><tr>
                  <th>Item</th>
                  <th className="fin-num">Quantity</th>
                  <th className="fin-num">Sales</th>
                  <th className="fin-num">Sales it was on</th>
                </tr></thead>
                <tbody>
                  {sales.categories.map(c => [
                    <tr key={`${c.label}-head`} className="fin-total">
                      <td>{c.label}</td>
                      <td className="fin-num" />
                      <td className="fin-num">{money(c.sales)}</td>
                      <td className="fin-num" />
                    </tr>,
                    ...c.items.map(i => (
                      <tr key={`${c.label}-${i.name}`}>
                        <td style={{ paddingLeft: 28 }}>{i.name}</td>
                        <td className="fin-num">{quantity(i.qty, i.unit)}</td>
                        <td className="fin-num">{money(i.sales)}</td>
                        <td className="fin-num fin-muted">{count(i.salesCount)}</td>
                      </tr>
                    )),
                  ])}
                </tbody>
              </table>
            )}
          </div>

          {/* ── How the items become the figure in the books ───────────── */}
          {tie ? (
            <div className="card fin-card">
              <div className="fin-card-head">
                <span className="fin-card-title">How that adds up to the books</span>
                <span className="fin-card-note">How the item lines become the figure the books hold. They should always agree, to the cent.</span>
              </div>
              <table className="data-table">
                <tbody>
                  {BOOKS_SALES_TIE_TERMS.filter(t => t === 'posted' || tie[t] !== 0).map(t => (
                    <tr key={t} className={t === 'posted' ? 'fin-total' : undefined}>
                      <td>
                        {BOOKS_SALES_TIE_TERM_LABEL[t]}
                        <div className="fin-muted">{BOOKS_SALES_TIE_TERM_NOTE[t]}</div>
                      </td>
                      <td className="fin-num">{signed(t, tie[t])}</td>
                    </tr>
                  ))}
                  {tie.difference ? (
                    <tr>
                      <td>
                        Unexplained difference
                        <div className="fin-muted">
                          Tell GAM: the item lines and the Register sales account do not agree over these days, and they always should.
                        </div>
                      </td>
                      <td className="fin-num fin-out">{money(tie.difference)}</td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          ) : null}

          {/* ── Other money in: the half Nic named first ───────────────── */}
          {other && other.rows.length ? (
            <div className="card fin-card">
              <div className="fin-card-head">
                <span className="fin-card-title">Other money in</span>
                <span className="fin-card-note">
                  Money filed as other income instead of rung up at the register — what it was, and who it came from.
                </span>
              </div>
              <table className="data-table">
                <thead><tr>
                  <th>Filed under</th>
                  <th>What the record said</th>
                  <th>From</th>
                  <th>Account it is in</th>
                  <th className="fin-num">Amount</th>
                  <th className="fin-num">Records</th>
                </tr></thead>
                <tbody>
                  {other.rows.map(r => (
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
                    <td className="fin-num">{money(other.total)}</td>
                    <td className="fin-num" />
                  </tr>
                </tbody>
              </table>
              {other.noTaxSplit ? (
                <p className="fin-muted" style={{ padding: '0 16px 14px' }}>
                  {money(other.noTaxSplit)} of this: {BOOKS_OTHER_INCOME_NO_TAX_NOTE}
                </p>
              ) : null}
            </div>
          ) : null}

          {/* ── Tax collected, by named tax ────────────────────────────── */}
          <div className="card fin-card">
            <div className="fin-card-head">
              <span className="fin-card-title">Tax collected, by tax</span>
              <span className="fin-card-note">
                Each tax, the sales it was charged on, what was collected, and the account the money is in — one line per agency.
              </span>
            </div>
            {!taxes || taxes.rows.length === 0 ? (
              <div className="fin-empty">{isLoading ? 'Loading…' : 'No tax was collected in these days.'}</div>
            ) : (
              <table className="data-table">
                <thead><tr>
                  <th>Tax</th>
                  <th>Account the money is in</th>
                  <th className="fin-num">Rate</th>
                  <th className="fin-num">Taxable sales</th>
                  <th className="fin-num">Collected</th>
                  <th className="fin-num">Sent on</th>
                  <th className="fin-num">Still to send</th>
                </tr></thead>
                <tbody>
                  {taxes.rows.map(r => {
                    const key = `${r.accountCode}|${r.taxName ?? ''}`
                    return [
                      <tr key={key}>
                        <td>
                          {r.label}
                          {r.unnamed ? (
                            <div className="fin-muted">
                              A sale charged this tax without recording which tax it was, so GAM could not file it under an agency.
                              Settle it with GAM before you file — it is not part of any agency’s figure above.
                            </div>
                          ) : null}
                        </td>
                        <td>{r.accountCode} {r.accountName}</td>
                        <td className="fin-num">{r.rates.length === 1 ? percent(r.rates[0].rate) : r.rates.length ? 'Several' : '—'}</td>
                        <td className="fin-num">
                          {r.rates.length ? money(r.taxableSales) : '—'}
                          {r.estimated ? <span className="fin-muted"> · worked back from the tax</span> : null}
                        </td>
                        <td className="fin-num">{money(r.collected)}</td>
                        <td className="fin-num">{money(r.paid)}</td>
                        <td className="fin-num">{money(r.unpaid)}</td>
                      </tr>,
                      // A rate change inside the period: both rates, each with
                      // the sales behind it, because the filing asks for both.
                      ...(r.rates.length > 1 ? r.rates.map(x => (
                        <tr key={`${key}-${x.rate}`}>
                          <td style={{ paddingLeft: 28 }} className="fin-muted">At {percent(x.rate)}</td>
                          <td />
                          <td className="fin-num">{percent(x.rate)}</td>
                          <td className="fin-num">{money(x.taxableSales)}</td>
                          <td className="fin-num">{money(x.collected)}</td>
                          <td className="fin-num" />
                          <td className="fin-num" />
                        </tr>
                      )) : []),
                    ]
                  })}
                  <tr className="fin-total">
                    <td>Total</td>
                    <td />
                    <td className="fin-num" />
                    <td className="fin-num">{money(taxes.totals.taxableSales)}</td>
                    <td className="fin-num">{money(taxes.totals.collected)}</td>
                    <td className="fin-num">{money(taxes.totals.paid)}</td>
                    <td className="fin-num">{money(taxes.totals.unpaid)}</td>
                  </tr>
                </tbody>
              </table>
            )}
            <p className="fin-muted" style={{ padding: '0 16px 14px' }}>
              GAM shows these figures; it does not file for you. Payroll tax is on the Tax Center — it is not collected from a customer.
            </p>
          </div>

          {/* 10/17 (Nic): the rate each of those taxes is charged at, where the
              person filing can correct one — "owner AND bookkeeper may change a
              rate", with every change kept so a filing traces to the rate in
              force. One home: a stay's price follows it too. */}
          <StayTaxCard propertyId={propertyId} />
        </>
      ) : null}
    </div>
  )
}

/** A bridge term with the sign it carries ("− $5.00"), so the column reads as the arithmetic it is. */
function signed(term: BooksSalesTieTerm, amount: number): string {
  const sign = BOOKS_SALES_TIE_TERM_SIGN[term]
  if (sign !== -1) return money(amount)
  return amount === 0 ? money(0) : `− ${money(Math.abs(amount))}`
}
