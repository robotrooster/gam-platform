import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { ScrollText, Check, X, AlertTriangle } from 'lucide-react'
import { apiGet, apiPatch } from '../lib/api'

// S198: landlord-side sublease decisions + termination.
// Backend: routes/subleases.ts (S197).
type Sublease = {
  id: string
  masterLeaseId: string
  status: 'pending' | 'awaiting_signatures' | 'active' | 'terminated'
  startDate: string
  endDate: string | null
  subMonthlyAmount: string
  masterShareAmount: string
  landlordConsentDate: string | null
  notes: string | null
  terminatedAt: string | null
  terminatedReason: string | null
  unitNumber: string
  propertyName: string
  sublessorName: string
  sublesseeName: string
  sublessorEmail: string
  sublesseeEmail: string
}

const STATUS_BADGE: Record<string, string> = {
  pending:              'badge-amber',
  awaiting_signatures:  'badge-gold',
  active:               'badge-green',
  terminated:           'badge-muted',
}

const fmtDate = (s: string | null) => s ? new Date(s).toLocaleDateString() : '—'
const fmtMoney = (s: string) =>
  `$${Number(s).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export function SubleasesPage() {
  const qc = useQueryClient()
  const [decideTarget, setDecideTarget] = useState<{ sublease: Sublease; decision: 'approve' | 'deny' } | null>(null)
  const [terminateTarget, setTerminateTarget] = useState<Sublease | null>(null)
  const [decideNote, setDecideNote] = useState('')
  const [terminateReason, setTerminateReason] = useState('')

  const { data: rows = [], isLoading } = useQuery<Sublease[]>(
    'subleases',
    () => apiGet<Sublease[]>('/subleases'),
  )

  const decideMut = useMutation(
    ({ id, decision, notes }: { id: string; decision: 'approve' | 'deny'; notes: string }) =>
      apiPatch(`/subleases/${id}/decision`, { decision, notes: notes || undefined }),
    {
      onSuccess: () => {
        qc.invalidateQueries('subleases')
        setDecideTarget(null)
        setDecideNote('')
      },
    },
  )

  const terminateMut = useMutation(
    ({ id, reason }: { id: string; reason: string }) =>
      apiPatch(`/subleases/${id}/terminate`, { reason }),
    {
      onSuccess: () => {
        qc.invalidateQueries('subleases')
        setTerminateTarget(null)
        setTerminateReason('')
      },
    },
  )

  const list = rows as Sublease[]
  const pendingCount = list.filter(r => r.status === 'pending').length

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <ScrollText size={22} /> Subleases
          </h1>
          <div className="page-sub">
            Sublease requests across your portfolio. Approve, deny, or terminate.
          </div>
        </div>
      </div>

      {pendingCount > 0 && (
        <div
          className="card"
          style={{
            padding: '10px 14px',
            marginBottom: 12,
            background: 'rgba(245,158,11,.08)',
            border: '1px solid rgba(245,158,11,.3)',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <AlertTriangle size={16} style={{ color: 'var(--amber)' }} />
          <span style={{ fontSize: '.85rem', color: 'var(--text-1)' }}>
            <strong>{pendingCount}</strong> sublease request{pendingCount === 1 ? '' : 's'} awaiting your decision.
          </span>
        </div>
      )}

      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        {isLoading ? (
          <div style={{ padding: 32, color: 'var(--text-3)', textAlign: 'center' }}>Loading…</div>
        ) : list.length === 0 ? (
          <div style={{ padding: 32, color: 'var(--text-3)', textAlign: 'center' }}>
            No subleases on any of your leases.
          </div>
        ) : (
          <table className="data-table" style={{ minWidth: 1000 }}>
            <thead>
              <tr>
                <th>Status</th>
                <th>Unit</th>
                <th>Sublessor</th>
                <th>Sublessee</th>
                <th>Term</th>
                <th>Sub-rent</th>
                <th>Master share</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {list.map(s => (
                <tr key={s.id}>
                  <td><span className={`badge ${STATUS_BADGE[s.status] || 'badge-muted'}`}>{s.status}</span></td>
                  <td>
                    <div style={{ color: 'var(--text-0)' }}>{s.unitNumber}</div>
                    <div style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>{s.propertyName}</div>
                  </td>
                  <td>
                    <div style={{ color: 'var(--text-0)', fontWeight: 600 }}>{s.sublessorName}</div>
                    <div style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>{s.sublessorEmail}</div>
                  </td>
                  <td>
                    <div style={{ color: 'var(--text-0)', fontWeight: 600 }}>{s.sublesseeName}</div>
                    <div style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>{s.sublesseeEmail}</div>
                  </td>
                  <td className="mono" style={{ fontSize: '.78rem' }}>
                    {fmtDate(s.startDate)}
                    <div style={{ fontSize: '.65rem', color: 'var(--text-3)' }}>→ {fmtDate(s.endDate)}</div>
                  </td>
                  <td className="mono">{fmtMoney(s.subMonthlyAmount)}</td>
                  <td className="mono">{fmtMoney(s.masterShareAmount)}</td>
                  <td style={{ textAlign: 'right' }}>
                    {s.status === 'pending' && (
                      <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                        <button
                          className="btn btn-ghost btn-sm"
                          style={{ color: 'var(--green)' }}
                          onClick={() => setDecideTarget({ sublease: s, decision: 'approve' })}
                        >
                          <Check size={13} /> Approve
                        </button>
                        <button
                          className="btn btn-ghost btn-sm"
                          style={{ color: 'var(--red)' }}
                          onClick={() => setDecideTarget({ sublease: s, decision: 'deny' })}
                        >
                          <X size={13} /> Deny
                        </button>
                      </div>
                    )}
                    {s.status === 'active' && (
                      <button
                        className="btn btn-ghost btn-sm"
                        style={{ color: 'var(--red)' }}
                        onClick={() => setTerminateTarget(s)}
                      >
                        Terminate
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Approve / Deny modal */}
      {decideTarget && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={() => setDecideTarget(null)}>
          <div className="card" style={{ width: 480, maxWidth: '92vw' }} onClick={e => e.stopPropagation()}>
            <h3 style={{ marginBottom: 12 }}>
              {decideTarget.decision === 'approve' ? 'Approve' : 'Deny'} sublease
            </h3>
            <div style={{ fontSize: '.85rem', color: 'var(--text-2)', marginBottom: 14, lineHeight: 1.5 }}>
              {decideTarget.sublease.sublessorName} → {decideTarget.sublease.sublesseeName} on Unit {decideTarget.sublease.unitNumber}, {decideTarget.sublease.propertyName}.
              <br />
              Term: {fmtDate(decideTarget.sublease.startDate)} → {fmtDate(decideTarget.sublease.endDate)} · {fmtMoney(decideTarget.sublease.subMonthlyAmount)}/mo
            </div>
            <label style={{ display: 'block', fontSize: '.72rem', color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 6 }}>
              Note (optional)
            </label>
            <textarea
              value={decideNote}
              onChange={e => setDecideNote(e.target.value)}
              className="input"
              rows={3}
              placeholder={decideTarget.decision === 'approve' ? 'Conditions, expectations, etc.' : 'Reason for denial'}
              style={{ marginBottom: 14 }}
            />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={() => setDecideTarget(null)}>Cancel</button>
              <button
                className="btn btn-primary"
                onClick={() => decideMut.mutate({ id: decideTarget.sublease.id, decision: decideTarget.decision, notes: decideNote })}
                disabled={decideMut.isLoading}
              >
                {decideMut.isLoading ? '…' : decideTarget.decision === 'approve' ? 'Approve' : 'Deny'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Terminate modal */}
      {terminateTarget && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={() => setTerminateTarget(null)}>
          <div className="card" style={{ width: 480, maxWidth: '92vw' }} onClick={e => e.stopPropagation()}>
            <h3 style={{ marginBottom: 12 }}>Terminate sublease</h3>
            <div style={{ fontSize: '.85rem', color: 'var(--text-2)', marginBottom: 14, lineHeight: 1.5 }}>
              Ending the sublease for Unit {terminateTarget.unitNumber}. The sublessor and sublessee will be notified.
            </div>
            <label style={{ display: 'block', fontSize: '.72rem', color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 6 }}>
              Reason (required)
            </label>
            <textarea
              value={terminateReason}
              onChange={e => setTerminateReason(e.target.value)}
              className="input"
              rows={3}
              placeholder="Why are you terminating this sublease?"
              style={{ marginBottom: 14 }}
            />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={() => setTerminateTarget(null)}>Cancel</button>
              <button
                className="btn btn-primary"
                onClick={() => terminateMut.mutate({ id: terminateTarget.id, reason: terminateReason })}
                disabled={terminateMut.isLoading || !terminateReason.trim()}
              >
                {terminateMut.isLoading ? '…' : 'Terminate'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
