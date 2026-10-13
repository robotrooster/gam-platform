/**
 * 10/11 (Nic): what GAM sent the company, and what GAM charged it. Read only;
 * the owner's Disbursements page keeps the payout-by-payout breakdown (it
 * names tenants) and the bank setup.
 *
 * One of the shared financial pages: the same bytes in the landlord portal and
 * GAM Books (financials-parity.test.ts). GET /financials/payouts.
 */
import { useQuery } from 'react-query'
import { finGet } from './adapter'
import { money, instantDay, errorWords, PageHead, Notice, useFinancialsScope } from './common'

interface Payout {
  id: string; createdAt: string; settledAt: string | null; amount: number; fee: number
  status: string; statusLabel: string; kindLabel: string
  bank: string | null; bankLast4: string | null; companyName: string | null
}
interface GamCharge {
  id: string; createdAt: string; kindLabel: string; propertyName: string | null; companyName: string | null
  amount: number; collected: number; collectedAt: string | null
}
interface PayoutData {
  payouts: Payout[]; totalSettled: number; totalOnTheWay: number; payoutCount?: number
  gamCharges: GamCharge[]; gamChargesOutstanding: number
}

export function PayoutsPage() {
  const { data: scope } = useFinancialsScope()
  const { data, isLoading, error } = useQuery<PayoutData>('financials-payouts',
    () => finGet<PayoutData>('/financials/payouts'), { retry: false })
  const payouts = data?.payouts ?? []
  const charges = data?.gamCharges ?? []
  const severalCompanies = (scope?.companies.length ?? 0) > 1

  return (
    <div className="fin">
      <PageHead title="Payouts"
        subtitle="Money GAM sent to the company's bank, and what GAM charged the company. It covers the whole company." />
      {error ? <Notice>{errorWords(error, 'Could not load payouts. Try again in a moment.')}</Notice> : (
        <>
          <div className="fin-kpis">
            <div className="fin-kpi">
              <div className="fin-kpi-label">Paid out</div>
              <div className="fin-kpi-value fin-in">{isLoading && !data ? '…' : money(data?.totalSettled ?? 0)}</div>
              <div className="fin-kpi-sub">Landed in the bank, all time</div>
            </div>
            <div className="fin-kpi">
              <div className="fin-kpi-label">On its way</div>
              <div className="fin-kpi-value">{money(data?.totalOnTheWay ?? 0)}</div>
            </div>
            <div className="fin-kpi">
              <div className="fin-kpi-label">GAM charges not yet taken</div>
              <div className="fin-kpi-value">{money(data?.gamChargesOutstanding ?? 0)}</div>
              <div className="fin-kpi-sub">Taken from the next payout, or from the linked bank account</div>
            </div>
          </div>

          <div className="card fin-card">
            <div className="fin-card-head"><span className="fin-card-title">Payouts</span></div>
            {/* 10/11: the totals above count every payout; the list stops at the newest ones. */}
            {(data?.payoutCount ?? 0) > payouts.length && (
              <div className="fin-card-head">
                <span className="fin-muted">
                  {`Showing the newest ${payouts.length.toLocaleString('en-US')} of ${(data?.payoutCount ?? 0).toLocaleString('en-US')} payouts. The totals count all of them.`}
                </span>
              </div>
            )}
            {payouts.length === 0 ? <div className="fin-empty">{isLoading ? 'Loading…' : 'No payouts yet.'}</div> : (
              <table className="data-table">
                <thead><tr>
                  <th>Sent</th>{severalCompanies && <th>Company</th>}<th>Kind</th><th>Bank</th><th>Status</th>
                  <th>Landed</th><th className="fin-num">Fee</th><th className="fin-num">Amount</th>
                </tr></thead>
                <tbody>
                  {payouts.map(p => (
                    <tr key={p.id}>
                      <td style={{ whiteSpace: 'nowrap' }}>{instantDay(p.createdAt)}</td>
                      {severalCompanies && <td className="fin-muted">{p.companyName || '—'}</td>}
                      <td className="fin-muted">{p.kindLabel}</td>
                      <td className="fin-muted">{p.bank ? `${p.bank}${p.bankLast4 ? ` ending ${p.bankLast4}` : ''}` : (p.bankLast4 ? `Ending ${p.bankLast4}` : '—')}</td>
                      <td>{p.statusLabel}</td>
                      <td className="fin-muted" style={{ whiteSpace: 'nowrap' }}>{p.settledAt ? instantDay(p.settledAt) : '—'}</td>
                      <td className="fin-num fin-muted">{p.fee > 0 ? money(-p.fee) : '—'}</td>
                      <td className="fin-num fin-in">{money(p.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="card fin-card">
            <div className="fin-card-head">
              <span className="fin-card-title">What GAM charged</span>
              <span className="fin-card-note">Taken from a payout on its way to the company, or from the linked bank account when no money is moving through GAM.</span>
            </div>
            {charges.length === 0 ? <div className="fin-empty">{isLoading ? 'Loading…' : 'No GAM charges.'}</div> : (
              <table className="data-table">
                <thead><tr>
                  <th>Charged</th>{severalCompanies && <th>Company</th>}<th>For</th><th>Property</th>
                  <th>Taken</th><th className="fin-num">Amount</th>
                </tr></thead>
                <tbody>
                  {charges.map(c => (
                    <tr key={c.id}>
                      <td style={{ whiteSpace: 'nowrap' }}>{instantDay(c.createdAt)}</td>
                      {severalCompanies && <td className="fin-muted">{c.companyName || '—'}</td>}
                      <td>{c.kindLabel}</td>
                      <td className="fin-muted">{c.propertyName || '—'}</td>
                      <td className="fin-muted">
                        {c.collected >= c.amount ? `Taken ${instantDay(c.collectedAt)}`
                          : c.collected > 0 ? `${money(c.collected)} taken so far` : 'Comes out of the next payout'}
                      </td>
                      <td className="fin-num">{money(c.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  )
}
