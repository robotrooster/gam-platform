/**
 * 10/12 (Nic, ledger P8): the general ledger — one account's lines for a
 * period, each with the running balance and the record behind it (a tenant
 * bill, a payment received, an expense, a payout, a journal entry …), so any
 * figure on a report can be followed to where it came from.
 *
 * A correction that cancelled an earlier line on the same day is folded away
 * by default (the two add to nothing); "Show corrections" lists them. A
 * correction that landed on another day — a fix made after a month was closed
 * — is always listed, marked.
 *
 * 10/12 (Nic, review): a busy account passes thousands of lines in a year, so
 * they come a page at a time; the page says which lines it shows and opens
 * the earlier and later ones. The balance at the end is always the whole
 * period's.
 *
 * GAM Books' own page, shown in GAM Books and inside the landlord portal's
 * Bookkeeping menu — the same bytes in apps/books and apps/landlord
 * (bookkeeping-parity.test.ts).
 */
import { useState } from 'react'
import { useQuery } from 'react-query'
import { Link, useSearchParams } from 'react-router-dom'
import { formatCurrency } from '@gam/shared'
import { booksGet as get, booksPath, expensesPagePath } from './adapter'
import { localToday, loadErrorText } from './booksMoney'
import { PeriodPickers, LedgerNotLive } from './LedgerStatements'

const DAY = /^\d{4}-\d{2}-\d{2}$/

/** Where a record behind a line opens, when it has a page of its own here. */
function recordLink(type: string): string | null {
  switch (type) {
    case 'expense': case 'expense_payment': return expensesPagePath()
    case 'manual_journal': return booksPath('journal')
    case 'payroll_run': return booksPath('payHistory')
    case 'loan': case 'loan_payment': return booksPath('loans')
    case 'fixed_asset': return booksPath('fixedAssets')
    case 'opening': return booksPath('openingBalances')
    default: return null
  }
}

export function GeneralLedgerPage() {
  const [params, setParams] = useSearchParams()
  const now = new Date()
  const accountId = params.get('accountId') ?? ''
  const startDate = DAY.test(params.get('startDate') ?? '') ? params.get('startDate')! : `${now.getFullYear()}-01-01`
  const endDate = DAY.test(params.get('endDate') ?? '') ? params.get('endDate')! : localToday(now)
  const [showCorrections, setShowCorrections] = useState(false)
  const [offset, setOffset] = useState(0)
  const set = (k: string, v: string) => { const p = new URLSearchParams(params); p.set(k, v); setParams(p, { replace: true }); setOffset(0) }

  const { data: accounts = [] } = useQuery('acct', () => get<any[]>('/books/accounts'))
  const { data, isLoading, error } = useQuery(['general-ledger', accountId, startDate, endDate, showCorrections, offset],
    () => get<any>(`/books/reports/general-ledger?accountId=${accountId}&startDate=${startDate}&endDate=${endDate}${showCorrections ? '&showCorrections=1' : ''}${offset ? `&offset=${offset}` : ''}`),
    { enabled: !!accountId, keepPreviousData: true })
  const lines: any[] = data?.lines ?? []
  const total = Number(data?.totalLines ?? lines.length)
  const pageSize = Number(data?.limit ?? lines.length) || 1
  const from = Number(data?.offset ?? 0)

  return (
    <div>
      <div className="ph">
        <div>
          <h1 className="pt">📒 General Ledger</h1>
          <p className="ps">One account, every line, the running balance and the record behind each line</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <select value={accountId} onChange={e => set('accountId', e.target.value)} aria-label="Account" style={{ width: 'auto', minWidth: 200, padding: '5px 8px', fontSize: '.75rem' }}>
            <option value="">Choose an account…</option>
            {accounts.map((a: any) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
          </select>
          <PeriodPickers startDate={startDate} endDate={endDate} setStartDate={v => set('startDate', v)} setEndDate={v => set('endDate', v)} />
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: '.75rem', color: 'var(--t2)' }}>
            <input type="checkbox" checked={showCorrections} onChange={e => { setShowCorrections(e.target.checked); setOffset(0) }} /> Show corrections
          </label>
        </div>
      </div>
      {!accountId ? <div className="card" style={{ color: 'var(--t3)', fontSize: '.8rem' }}>Choose an account to see its lines. The trial balance opens any account here too.</div>
        : !!error ? <div className="alert aw">{loadErrorText(error, 'Could not load the general ledger.')}</div>
        : isLoading ? <div style={{ padding: 32, color: 'var(--t3)', textAlign: 'center' }}><span className="spinner" style={{ display: 'inline-block' }} /></div>
        : data?.live === false ? <LedgerNotLive reason={data.reason} />
        : (
          <div className="card">
            <div className="ct">{data?.account?.code} · {data?.account?.name}</div>
            {total > lines.length && (
              <div className="bnote" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <span>Showing lines {lines.length ? from + 1 : 0}–{from + lines.length} of {total}. Each balance counts every line before it.</span>
                {from > 0 && <button className="btn bp bsm" onClick={() => setOffset(Math.max(0, from - pageSize))}>Earlier lines</button>}
                {from + lines.length < total && <button className="btn bp bsm" onClick={() => setOffset(from + pageSize)}>Later lines</button>}
              </div>
            )}
            <div style={{ overflowX: 'auto' }}>
              <table className="tbl" style={{ minWidth: 680 }}>
                <thead><tr>
                  <th>Date</th><th>What</th><th>Property</th><th>Who</th>
                  <th style={{ textAlign: 'right' }}>Debit</th><th style={{ textAlign: 'right' }}>Credit</th><th style={{ textAlign: 'right' }}>Balance</th>
                </tr></thead>
                <tbody>
                  <tr>
                    <td className="mono" style={{ fontSize: '.75rem' }}>{new Date(`${startDate}T12:00:00`).toLocaleDateString()}</td>
                    <td colSpan={5} style={{ fontSize: '.78rem', color: 'var(--t2)' }}>Balance at the start{from > 0 ? ' (the lines before these are on earlier pages)' : ''}</td>
                    <td className="mono" style={{ textAlign: 'right' }}>{formatCurrency(data?.opening ?? 0)}</td>
                  </tr>
                  {lines.map(l => {
                    const to = recordLink(l.source.type)
                    return (
                      <tr key={l.lineId} style={l.correction ? { background: 'var(--bg3)' } : undefined}>
                        <td className="mono" style={{ fontSize: '.75rem', whiteSpace: 'nowrap' }}>
                          {new Date(`${l.day}T12:00:00`).toLocaleDateString()}
                          {l.day !== l.intendedDay && <div style={{ fontSize: '.65rem', color: 'var(--amber)' }}>for {new Date(`${l.intendedDay}T12:00:00`).toLocaleDateString()}</div>}
                        </td>
                        <td style={{ fontSize: '.78rem' }}>
                          {to ? <Link to={to}>{l.source.label}</Link> : l.source.label}
                          {(l.memo || l.postingMemo) && <div style={{ fontSize: '.7rem', color: 'var(--t3)' }}>{l.memo || l.postingMemo}</div>}
                          {l.correction && <div style={{ fontSize: '.65rem', color: 'var(--amber)' }}>Correction</div>}
                        </td>
                        <td style={{ fontSize: '.75rem' }}>{l.propertyName ?? 'Company'}</td>
                        <td style={{ fontSize: '.75rem' }}>{l.tenantName ?? l.vendorName ?? ''}</td>
                        <td className="mono" style={{ textAlign: 'right' }}>{l.debit ? formatCurrency(l.debit) : ''}</td>
                        <td className="mono" style={{ textAlign: 'right' }}>{l.credit ? formatCurrency(l.credit) : ''}</td>
                        <td className="mono" style={{ textAlign: 'right' }}>{formatCurrency(l.balance)}</td>
                      </tr>
                    )
                  })}
                  <tr style={{ borderTop: '2px solid var(--b1)' }}>
                    <td className="mono" style={{ fontSize: '.75rem' }}>{new Date(`${endDate}T12:00:00`).toLocaleDateString()}</td>
                    <td colSpan={5} style={{ fontWeight: 700, color: 'var(--t0)' }}>Balance at the end</td>
                    <td className="mono" style={{ textAlign: 'right', fontWeight: 700 }}>{formatCurrency(data?.closing ?? 0)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            {!showCorrections && !!data?.hiddenCorrections && (
              <div className="bnote">{data.hiddenCorrections} line{data.hiddenCorrections === 1 ? '' : 's'} of corrections made the same day {data.hiddenCorrections === 1 ? 'is' : 'are'} folded away (they add up to nothing). Tick “Show corrections” to see them.</div>
            )}
          </div>
        )}
    </div>
  )
}
