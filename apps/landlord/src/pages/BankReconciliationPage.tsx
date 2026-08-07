// S568 (Nic): bank reconciliation. Reconcile your bank statement against what
// GAM sent you, and log bank charges (categorized → they flow into your P&L).
// S576 (B-5): DISTINCT from Bank Feed (S570). This page answers "does my monthly
// statement match GAM's disbursements?" — period-end matching. Bank Feed pulls a
// linked bank's transactions and categorizes spend into the P&L. The stale
// "manual until Plaid" note was removed: the live feed exists now (Stripe FC);
// this manual charge-log is the fallback for un-linked banks / missed charges.
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { apiGet, apiPost } from '../lib/api'
import { toast } from '../components/dialogs'

const fmt = (n: any) => n != null ? `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'
const monthBounds = (ym: string) => {
  const [y, m] = ym.split('-').map(Number)
  const from = `${ym}-01`
  const to = new Date(y, m, 0).toISOString().slice(0, 10)   // last day
  return { from, to }
}

export function BankReconciliationPage() {
  const qc = useQueryClient()
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7))
  const { from, to } = monthBounds(month)
  const { data: ctx } = useQuery(['bank-rec-context', from, to], () => apiGet<any>(`/bank-reconciliations/context?from=${from}&to=${to}`))
  const { data: history = [] } = useQuery<any[]>('bank-rec-history', () => apiGet('/bank-reconciliations'))

  const [charge, setCharge] = useState({ amount: '', description: '', expenseDate: from })
  const [statementBalance, setStatementBalance] = useState('')

  const gamDisbursed = ctx?.gamDisbursed ?? 0
  const bankChargesTotal = ctx?.bankChargesTotal ?? 0
  const bankCharges: any[] = ctx?.bankCharges ?? []

  const logCharge = useMutation(
    () => apiPost('/expenses', { category: 'bank_fees', amount: Number(charge.amount), expenseDate: charge.expenseDate || from, description: charge.description.trim() || 'Bank charge' }),
    { onSuccess: () => { qc.invalidateQueries(['bank-rec-context', from, to]); setCharge({ amount: '', description: '', expenseDate: from }); toast('Bank charge logged.') } })

  const save = useMutation(
    () => apiPost('/bank-reconciliations', { periodStart: from, periodEnd: to, statementBalance: Number(statementBalance) }),
    { onSuccess: () => { qc.invalidateQueries('bank-rec-history'); setStatementBalance(''); toast('Reconciliation saved.') } })

  const difference = statementBalance !== '' ? Number(statementBalance) - gamDisbursed : null

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Bank Reconciliation</h1>
          <p className="page-subtitle">Match your statement to what GAM sent you, and categorize bank charges into your P&L.</p>
        </div>
        <input className="form-input" type="month" value={month} onChange={e => { setMonth(e.target.value); setCharge(c => ({ ...c, expenseDate: e.target.value + '-01' })) }} style={{ width: 'auto' }} />
      </div>

      {/* S576 (B-5): signpost the sibling workflow — this MATCHES a statement;
          Bank Feed CATEGORIZES linked-bank spend. */}
      <div style={{ fontSize: '.76rem', color: 'var(--text-3)', marginBottom: 16, lineHeight: 1.5 }}>
        This <strong>matches a month's deposits</strong> to what GAM sent you. To pull and
        categorize spending from a linked bank into your P&L, use{' '}
        <Link to="/bank-feed" style={{ color: 'var(--gold)', fontWeight: 600 }}>Bank Feed</Link>.
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12, marginBottom: 20 }}>
        {[['GAM sent you', fmt(gamDisbursed)], ['Bank charges logged', fmt(bankChargesTotal)],
          ['Statement vs GAM', difference == null ? '—' : fmt(difference)]].map(([k, v], i) => (
          <div key={k} className="card" style={{ padding: '14px 16px' }}>
            <div style={{ fontSize: '.65rem', fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>{k}</div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: '1.05rem', fontWeight: 700, color: i === 2 && difference && difference !== 0 ? 'var(--amber)' : 'var(--text-0)' }}>{v}</div>
          </div>
        ))}
      </div>

      <div className="card" style={{ marginBottom: 20, maxWidth: 640 }}>
        <div className="card-title" style={{ marginBottom: 12 }}>Log a bank charge</div>
        <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginBottom: 10 }}>
          Bank fees, wire fees, NSF charges — recorded as expenses and flow into your P&L.
          If your bank is linked in <Link to="/bank-feed" style={{ color: 'var(--gold)' }}>Bank Feed</Link>, these get captured there automatically — use this for manual entry.
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>Amount
            <input className="form-input" type="number" inputMode="decimal" placeholder="0.00" style={{ width: 110 }} value={charge.amount} onChange={e => setCharge(c => ({ ...c, amount: e.target.value }))} />
          </label>
          <label style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>Date
            <input className="form-input" type="date" style={{ width: 150 }} value={charge.expenseDate} onChange={e => setCharge(c => ({ ...c, expenseDate: e.target.value }))} />
          </label>
          <label style={{ fontSize: '.72rem', color: 'var(--text-3)', flex: 1 }}>Description
            <input className="form-input" placeholder="e.g. Monthly account fee" value={charge.description} onChange={e => setCharge(c => ({ ...c, description: e.target.value }))} />
          </label>
          <button className="btn btn-primary btn-sm" disabled={!charge.amount || Number(charge.amount) <= 0 || logCharge.isLoading} onClick={() => logCharge.mutate()}>Log</button>
        </div>
        {bankCharges.length > 0 && (
          <div style={{ marginTop: 12 }}>
            {bankCharges.map(c => (
              <div key={c.id} style={{ fontSize: '.76rem', color: 'var(--text-2)', display: 'flex', justifyContent: 'space-between', padding: '3px 0' }}>
                <span>{new Date(String(c.expenseDate).slice(0, 10) + 'T12:00:00').toLocaleDateString()} · {c.description}</span>
                <span>{fmt(c.amount)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card" style={{ marginBottom: 20, maxWidth: 640 }}>
        <div className="card-title" style={{ marginBottom: 12 }}>Reconcile {new Date(from + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
          <label style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>Your bank statement total (deposits from GAM)
            <input className="form-input" type="number" inputMode="decimal" placeholder="0.00" style={{ width: 180 }} value={statementBalance} onChange={e => setStatementBalance(e.target.value)} />
          </label>
          <button className="btn btn-primary btn-sm" disabled={statementBalance === '' || save.isLoading} onClick={() => save.mutate()}>Save reconciliation</button>
        </div>
        {difference != null && (
          <div style={{ fontSize: '.75rem', marginTop: 10, color: difference === 0 ? 'var(--green)' : 'var(--amber)' }}>
            {difference === 0 ? 'Matches GAM exactly ✓' : `${fmt(Math.abs(difference))} ${difference < 0 ? 'less than' : 'more than'} GAM sent — usually explained by bank charges (log them above) or non-GAM deposits.`}
          </div>
        )}
      </div>

      {history.length > 0 && (
        <div className="card" style={{ padding: 0 }}>
          <div className="card-title" style={{ padding: '14px 16px 0' }}>Past reconciliations</div>
          <table className="data-table">
            <thead><tr><th>Period</th><th>Statement</th><th>GAM sent</th><th>Difference</th></tr></thead>
            <tbody>
              {history.map(r => (
                <tr key={r.id}>
                  <td style={{ fontSize: '.8rem' }}>{new Date(String(r.periodStart).slice(0, 10) + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}</td>
                  <td>{fmt(r.statementBalance)}</td>
                  <td>{fmt(r.bookBalance)}</td>
                  <td style={{ color: r.difference === 0 ? 'var(--green)' : 'var(--amber)' }}>{fmt(r.difference)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
