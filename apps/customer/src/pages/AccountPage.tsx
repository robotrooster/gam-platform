import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { apiGet, apiPost } from '../lib/api'
import { enablePush, pushPermission, pushSupported } from '../lib/push'

interface Invoice {
  id: string; number: string; status: string; dueDate: string
  total: number; amountPaid: number; amountDue: number; payable: boolean
  depositAmount: number; depositType: 'service' | 'materials' | null
  depositPaid: boolean; amountDueNow: number
  nextPaymentKind: 'deposit' | 'balance' | 'none'
}
interface Account {
  business: { name: string }
  customer: { name: string }
  outstanding: number
  invoices: Invoice[]
}
interface Appointment {
  id: string; serviceType: string; scheduledFor: string
  state: 'completed' | 'skipped' | 'scheduled' | 'cancelled' | 'en_route'
  completedAt: string | null; skippedAt: string | null
  skipReason: string | null; arrivedAt: string | null
  etaAt: string | null
}

const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '—'
const fmtDateTime = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'
const money = (n: number) => `$${n.toFixed(2)}`

export function AccountPage() {
  const { token } = useParams<{ token: string }>()
  const [account, setAccount] = useState<Account | null>(null)
  const [appts, setAppts] = useState<Appointment[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [paying, setPaying] = useState<string | null>(null)
  const [perm, setPerm] = useState<string>(() => pushPermission())
  const [pushMsg, setPushMsg] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    Promise.all([
      apiGet<Account>(`/public/customer/${token}`),
      apiGet<{ appointments: Appointment[] }>(`/public/customer/${token}/service`),
    ])
      .then(([acct, svc]) => { if (alive) { setAccount(acct); setAppts(svc.appointments) } })
      .catch((e: any) => { if (alive) setErr(e?.message || 'This link is invalid or has expired.') })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [token])

  // Keep the open portal live (status + ETA) without a manual refresh.
  useEffect(() => {
    const id = window.setInterval(() => {
      apiGet<{ appointments: Appointment[] }>(`/public/customer/${token}/service`)
        .then(svc => setAppts(svc.appointments)).catch(() => {})
    }, 30_000)
    return () => window.clearInterval(id)
  }, [token])

  const onEnableAlerts = async () => {
    const r = await enablePush(token!)
    setPerm(pushPermission())
    setPushMsg(
      r === 'subscribed' ? 'Alerts on — we’ll notify you when the driver is on the way.'
      : r === 'denied' ? 'Notifications are blocked in your browser settings.'
      : r === 'unsupported' ? 'This browser doesn’t support alerts.'
      : 'Couldn’t enable alerts — please try again.')
  }

  const pay = async (invoiceId: string) => {
    setPaying(invoiceId); setErr(null)
    try {
      const { hostedUrl } = await apiPost<{ hostedUrl: string }>(`/public/customer/${token}/invoices/${invoiceId}/pay`)
      window.location.href = hostedUrl
    } catch (e: any) {
      setErr(e?.message || 'Could not start payment.')
      setPaying(null)
    }
  }

  if (loading) return <div style={center}>Loading…</div>
  if (err && !account) {
    return (
      <div style={center}>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 20, color: 'var(--text-0)', marginBottom: 8 }}>
          Link unavailable
        </div>
        <div style={{ color: 'var(--text-2)', maxWidth: 360 }}>{err}</div>
      </div>
    )
  }
  if (!account) return null

  return (
    <div style={page}>
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 13, color: 'var(--gold)', letterSpacing: 1, textTransform: 'uppercase' }}>
          {account.business.name}
        </div>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 26, color: 'var(--text-0)' }}>
          Hi {account.customer.name}
        </div>
      </div>

      {pushSupported() && perm !== 'granted' && (
        <div style={alertsCard}>
          <div style={{ flex: 1, fontSize: 13, color: 'var(--text-1)' }}>
            Get notified when the driver is on the way.
          </div>
          <button onClick={onEnableAlerts} style={alertsBtn}>Enable alerts</button>
        </div>
      )}
      {perm === 'granted' && !pushMsg && (
        <div style={{ ...alertsCard, color: 'var(--green)' }}>
          <div style={{ fontSize: 13 }}>Alerts are on — we’ll let you know when the driver is on the way.</div>
        </div>
      )}
      {pushMsg && <div style={{ ...alertsCard, fontSize: 13, color: 'var(--text-2)' }}>{pushMsg}</div>}

      {err && <div style={errBox}>{err}</div>}

      {/* Service status */}
      <h2 style={h2}>Service status</h2>
      {!appts || appts.length === 0 ? (
        <div style={empty}>No recent or upcoming service.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 28 }}>
          {appts.map((a) => <ServiceRow key={a.id} a={a} />)}
        </div>
      )}

      {/* Invoices */}
      <h2 style={h2}>
        Invoices
        {account.outstanding > 0.005 && (
          <span style={{ marginLeft: 10, fontSize: 13, color: 'var(--amber)' }}>
            {money(account.outstanding)} due
          </span>
        )}
      </h2>
      {account.invoices.length === 0 ? (
        <div style={empty}>No invoices yet.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {account.invoices.map((inv) => (
            <div key={inv.id} style={rowCard}>
              <div>
                <div style={{ fontWeight: 600, color: 'var(--text-0)' }}>{inv.number}</div>
                <div style={{ fontSize: 12, color: 'var(--text-3)' }}>Due {fmtDate(inv.dueDate)}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ color: 'var(--text-1)' }}>{money(inv.total)}</div>
                {inv.amountDue > 0.005 ? (
                  <div style={{ fontSize: 12, color: 'var(--amber)' }}>
                    {inv.nextPaymentKind === 'deposit'
                      ? `${money(inv.amountDueNow)} deposit due`
                      : `${money(inv.amountDue)} due`}
                  </div>
                ) : (
                  <div style={{ fontSize: 12, color: 'var(--green)' }}>Paid</div>
                )}
                {inv.depositAmount > 0 && inv.depositPaid && inv.amountDue > 0.005 && (
                  <div style={{ fontSize: 11, color: 'var(--text-3)' }}>Deposit paid · balance below</div>
                )}
              </div>
              {inv.payable && (
                <button onClick={() => pay(inv.id)} disabled={paying === inv.id}
                  style={{ ...payBtn, opacity: paying === inv.id ? 0.6 : 1 }}>
                  {paying === inv.id
                    ? '…'
                    : inv.nextPaymentKind === 'deposit'
                      ? `Pay deposit ${money(inv.amountDueNow)}`
                      : `Pay ${money(inv.amountDueNow)}`}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ServiceRow({ a }: { a: Appointment }) {
  const badge = {
    completed: { label: 'Completed', color: 'var(--green)', bg: 'var(--green-bg)' },
    skipped:   { label: 'Skipped',   color: 'var(--amber)', bg: 'var(--amber-bg)' },
    cancelled: { label: 'Cancelled', color: 'var(--red)',   bg: 'var(--red-bg)' },
    scheduled: { label: 'Scheduled', color: 'var(--text-2)', bg: 'var(--bg-2)' },
    en_route:  { label: 'You’re next', color: 'var(--gold)', bg: 'var(--gold-bg)' },
  }[a.state]

  const detail =
    a.state === 'completed' ? `Completed ${fmtDateTime(a.completedAt)}`
    : a.state === 'skipped' ? `Couldn’t be completed ${fmtDateTime(a.skippedAt)}${a.skipReason ? ` — ${a.skipReason}` : ''}`
    : a.state === 'cancelled' ? 'Cancelled'
    : a.state === 'en_route' ? `The driver is on the way${a.etaAt ? ` — arriving ~${fmtDateTime(a.etaAt)}` : ''}`
    : a.etaAt ? `Scheduled — arriving ~${fmtDateTime(a.etaAt)}` : `Scheduled for ${fmtDateTime(a.scheduledFor)}`

  return (
    <div style={{ ...rowCard, borderLeft: `3px solid ${badge.color}` }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 600, color: 'var(--text-0)', textTransform: 'capitalize' }}>
          {a.serviceType}
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-2)', marginTop: 2 }}>{detail}</div>
      </div>
      <span style={{
        padding: '4px 10px', borderRadius: 6, fontSize: 11, fontWeight: 700,
        color: badge.color, background: badge.bg, whiteSpace: 'nowrap',
      }}>{badge.label}</span>
    </div>
  )
}

const page: React.CSSProperties = { maxWidth: 640, margin: '0 auto', padding: '32px 16px 64px' }
const center: React.CSSProperties = {
  minHeight: '100vh', display: 'flex', flexDirection: 'column',
  alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 24,
  color: 'var(--text-2)',
}
const h2: React.CSSProperties = {
  fontFamily: 'var(--font-body)', fontSize: 16, color: 'var(--text-1)',
  margin: '0 0 12px', fontWeight: 600,
}
const rowCard: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 14, padding: 14,
  background: 'var(--bg-1)', border: '1px solid var(--border-0)', borderRadius: 10,
}
const empty: React.CSSProperties = {
  padding: 24, textAlign: 'center', color: 'var(--text-2)', fontSize: 14,
  background: 'var(--bg-1)', border: '1px solid var(--border-0)', borderRadius: 10,
  marginBottom: 28,
}
const payBtn: React.CSSProperties = {
  padding: '8px 16px', background: 'var(--gold)', color: 'var(--bg-0)',
  border: 'none', borderRadius: 7, fontSize: 13, fontWeight: 700,
}
const errBox: React.CSSProperties = {
  padding: '10px 12px', marginBottom: 16,
  background: 'var(--red-bg)', color: 'var(--red)',
  border: '1px solid var(--red)', borderRadius: 8, fontSize: 13,
}
const alertsCard: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', marginBottom: 16,
  background: 'var(--bg-1)', border: '1px solid var(--border-0)', borderRadius: 10,
}
const alertsBtn: React.CSSProperties = {
  padding: '8px 14px', background: 'var(--gold)', color: 'var(--bg-0)',
  border: 'none', borderRadius: 7, fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap',
}
