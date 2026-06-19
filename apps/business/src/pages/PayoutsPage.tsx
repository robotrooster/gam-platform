import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { apiGet, apiPost } from '../lib/api'
import { Modal } from '../components/Modal'
import { Banknote, ArrowRight, AlertTriangle, RefreshCw } from 'lucide-react'

interface Balance {
  availableUsd: number
  pendingUsd: number
  instantAvailableUsd: number
}
interface Payout {
  id: string
  stripePayoutId: string
  amount: string
  currency: string
  status: 'pending' | 'paid' | 'failed' | 'canceled' | 'in_transit'
  destinationBankLast4: string | null
  arrivalDate: string | null
  failureMessage: string | null
  createdAt: string
}

function fmtMoney(n: string | number | null | undefined): string {
  if (n == null) return '$0.00'
  return `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
function fmtDate(s: string | null | undefined): string {
  if (!s) return '—'
  return new Date(s).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
}

export function PayoutsPage() {
  const [balance, setBalance] = useState<Balance | null>(null)
  const [payouts, setPayouts] = useState<Payout[]>([])
  const [notConnected, setNotConnected] = useState(false)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [showPayout, setShowPayout] = useState(false)

  const reload = async () => {
    setErr(null); setLoading(true)
    try {
      const [bal, list] = await Promise.all([
        apiGet<Balance>('/businesses/me/connect/balance'),
        apiGet<Payout[]>('/businesses/me/connect/payouts'),
      ])
      setBalance(bal)
      setPayouts(list)
      setNotConnected(false)
    } catch (e: any) {
      if (e?.response?.status === 409) { setNotConnected(true) }
      else { setErr(e?.response?.data?.error || 'Failed to load payouts') }
    } finally { setLoading(false) }
  }
  useEffect(() => { reload() }, [])

  if (notConnected) {
    return (
      <div>
        <h1 style={hdr}>Payouts</h1>
        <div style={{ ...card, marginTop: 16, textAlign: 'center' as const, padding: 40 }}>
          <Banknote size={36} color="var(--text-3)" style={{ marginBottom: 10 }} />
          <div style={{ color: 'var(--text-1)', fontWeight: 600, marginBottom: 6 }}>Connect payments to see your money</div>
          <div style={{ color: 'var(--text-2)', fontSize: 14, marginBottom: 16 }}>
            Set up Stripe in Settings to accept payments and get paid out.
          </div>
          <Link to="/settings" style={{ ...primaryBtn, textDecoration: 'none' }}>
            Go to Settings <ArrowRight size={14} />
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 16 }}>
        <div>
          <h1 style={hdr}>Payouts</h1>
          <div style={{ color: 'var(--text-2)', fontSize: 14, marginTop: 4 }}>
            Your Stripe balance and payout history.
          </div>
        </div>
        <button onClick={reload} style={ghostBtn}><RefreshCw size={14} /> Refresh</button>
      </div>

      {err && <div style={errStyle}>{err}</div>}

      {/* Balance cards */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
        <div style={card}>
          <div style={{ color: 'var(--text-2)', fontSize: 12, textTransform: 'uppercase' as const, letterSpacing: 1 }}>Available</div>
          <div style={{ fontSize: 30, fontWeight: 700, color: 'var(--gold)', fontFamily: 'var(--font-mono)' as const, marginTop: 6 }}>
            {loading ? '—' : fmtMoney(balance?.availableUsd)}
          </div>
          <button
            onClick={() => setShowPayout(true)}
            disabled={loading || !balance || balance.availableUsd <= 0}
            style={{ ...primaryBtn, marginTop: 12,
              opacity: (!balance || balance.availableUsd <= 0) ? 0.5 : 1,
              cursor: (!balance || balance.availableUsd <= 0) ? 'not-allowed' : 'pointer' }}>
            <Banknote size={14} /> Pay out now
          </button>
        </div>
        <div style={card}>
          <div style={{ color: 'var(--text-2)', fontSize: 12, textTransform: 'uppercase' as const, letterSpacing: 1 }}>Pending</div>
          <div style={{ fontSize: 30, fontWeight: 700, color: 'var(--text-1)', fontFamily: 'var(--font-mono)' as const, marginTop: 6 }}>
            {loading ? '—' : fmtMoney(balance?.pendingUsd)}
          </div>
          <div style={{ color: 'var(--text-3)', fontSize: 12, marginTop: 12 }}>
            Still settling — becomes available automatically.
          </div>
        </div>
      </div>

      {/* History */}
      <h2 style={{ fontSize: 16, color: 'var(--text-0)', margin: '20px 0 10px' }}>History</h2>
      {payouts.length === 0 ? (
        <div style={{ ...card, color: 'var(--text-2)', fontSize: 14 }}>No payouts yet.</div>
      ) : (
        <table style={tableStyle}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border-1)' }}>
              <th style={thStyle}>Date</th>
              <th style={thStyle}>Amount</th>
              <th style={thStyle}>To</th>
              <th style={thStyle}>Arrival</th>
              <th style={thStyle}>Status</th>
            </tr>
          </thead>
          <tbody>
            {payouts.map(p => (
              <tr key={p.id} style={{ borderBottom: '1px solid var(--border-0)' }}>
                <td style={tdStyle}>{fmtDate(p.createdAt)}</td>
                <td style={{ ...tdStyle, fontFamily: 'var(--font-mono)' as const, fontWeight: 600 }}>{fmtMoney(p.amount)}</td>
                <td style={tdStyle}>{p.destinationBankLast4 ? `•••• ${p.destinationBankLast4}` : '—'}</td>
                <td style={tdStyle}>{fmtDate(p.arrivalDate)}</td>
                <td style={tdStyle}><PayoutStatus status={p.status} message={p.failureMessage} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {showPayout && balance && (
        <PayoutModal available={balance.availableUsd}
          onClose={() => setShowPayout(false)}
          onDone={() => { setShowPayout(false); reload() }} />
      )}
    </div>
  )
}

function PayoutStatus({ status, message }: { status: Payout['status']; message: string | null }) {
  const color = status === 'paid' ? 'var(--green, #22c55e)'
              : status === 'failed' || status === 'canceled' ? 'var(--red, #ef4444)'
              : 'var(--gold)'
  return (
    <span title={message ?? undefined} style={{
      padding: '3px 8px', fontSize: 11, fontWeight: 700,
      textTransform: 'uppercase' as const, letterSpacing: 0.5,
      border: `1px solid ${color}`, color, borderRadius: 4,
    }}>{status.replace('_', ' ')}</span>
  )
}

function PayoutModal({ available, onClose, onDone }: { available: number; onClose: () => void; onDone: () => void }) {
  const [mode, setMode] = useState<'all' | 'amount'>('all')
  const [amount, setAmount] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = async () => {
    setErr(null)
    const payload: any = {}
    if (mode === 'amount') {
      const a = parseFloat(amount)
      if (isNaN(a) || a <= 0) { setErr('Enter an amount'); return }
      if (a > available + 0.005) { setErr(`Max is ${fmtMoney(available)}`); return }
      payload.amount = a
    }
    setSubmitting(true)
    try {
      await apiPost('/businesses/me/connect/payouts', payload)
      onDone()
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Payout failed')
    } finally { setSubmitting(false) }
  }

  return (
    <Modal title="Pay out to your bank" onClose={onClose}
      footer={
        <>
          <button onClick={onClose} style={ghostBtn}>Cancel</button>
          <button onClick={submit} disabled={submitting} style={primaryBtn}>
            {submitting ? 'Sending…' : 'Pay out'}
          </button>
        </>
      }>
      {err && <div style={errStyle}>{err}</div>}
      <div style={{ padding: 12, background: 'var(--bg-2)', borderRadius: 8, marginBottom: 14, fontSize: 13, color: 'var(--text-1)' }}>
        Available to pay out: <strong style={{ color: 'var(--gold)' }}>{fmtMoney(available)}</strong>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        {(['all', 'amount'] as const).map(m => (
          <button key={m} onClick={() => setMode(m)} style={{
            flex: 1, padding: 10,
            background: mode === m ? 'rgba(212,175,55,.12)' : 'var(--bg-2)',
            border: `1px solid ${mode === m ? 'var(--gold)' : 'var(--border-1)'}`,
            borderRadius: 8, color: mode === m ? 'var(--gold)' : 'var(--text-1)',
            fontSize: 13, fontWeight: 600, cursor: 'pointer',
          }}>{m === 'all' ? 'Entire balance' : 'Specific amount'}</button>
        ))}
      </div>

      {mode === 'amount' && (
        <input type="number" step="0.01" min={0} max={available} value={amount}
          onChange={e => setAmount(e.target.value)} placeholder="0.00"
          style={{ ...inp, fontFamily: 'var(--font-mono)' as const, fontSize: 18 }} autoFocus />
      )}

      <div style={{ display: 'flex', gap: 8, alignItems: 'start', marginTop: 12, fontSize: 12, color: 'var(--text-2)' }}>
        <AlertTriangle size={14} style={{ color: 'var(--amber)', flexShrink: 0, marginTop: 1 }} />
        <span>Standard payouts land in your bank in 1–2 business days. GAM never holds your money — this moves it straight from Stripe to your bank.</span>
      </div>
    </Modal>
  )
}

const hdr: React.CSSProperties = { fontFamily: 'var(--font-display)', fontSize: 28, margin: 0 }
const card: React.CSSProperties = {
  background: 'var(--bg-1)', border: '1px solid var(--border-0)', borderRadius: 12, padding: 18,
}
const tableStyle: React.CSSProperties = {
  width: '100%', borderCollapse: 'collapse' as const,
  background: 'var(--bg-1)', border: '1px solid var(--border-0)', borderRadius: 12, overflow: 'hidden' as const,
}
const thStyle: React.CSSProperties = {
  textAlign: 'left' as const, padding: '12px 16px', fontSize: 12, color: 'var(--text-2)',
  textTransform: 'uppercase' as const, letterSpacing: 1, background: 'var(--bg-2)', fontWeight: 600,
}
const tdStyle: React.CSSProperties = { padding: '12px 16px', fontSize: 14, color: 'var(--text-1)' }
const inp: React.CSSProperties = {
  width: '100%', padding: '10px 12px', background: 'var(--bg-2)', color: 'var(--text-0)',
  border: '1px solid var(--border-1)', borderRadius: 8, fontSize: 14, boxSizing: 'border-box' as const,
}
const primaryBtn: React.CSSProperties = {
  padding: '8px 14px', background: 'var(--gold)', color: 'var(--bg-0)', border: 'none',
  borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer',
  display: 'inline-flex' as const, alignItems: 'center', gap: 6,
}
const ghostBtn: React.CSSProperties = {
  padding: '8px 14px', background: 'transparent', color: 'var(--text-1)',
  border: '1px solid var(--border-1)', borderRadius: 8, fontSize: 13, fontWeight: 500, cursor: 'pointer',
  display: 'inline-flex' as const, alignItems: 'center', gap: 6,
}
const errStyle: React.CSSProperties = {
  marginBottom: 12, padding: '10px 12px', background: 'var(--red-bg)',
  color: 'var(--red, #ef4444)', border: '1px solid var(--red-dim, #ef4444)', borderRadius: 8, fontSize: 13,
}
