import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { useParams, useNavigate } from 'react-router-dom'
import { DoorOpen, ArrowLeft, CheckCircle2, XCircle, Clock, AlertTriangle } from 'lucide-react'
import { apiGet, apiPost } from '../lib/api'

type Detail = {
  id: string
  unitId: string
  tenantId: string
  landlordId: string
  reason: string
  reasonCategory: string
  status: 'pending' | 'granted' | 'denied' | 'completed' | 'breached' | 'cancelled'
  noticeGivenAt: string
  proposedEntryWindowStart: string
  proposedEntryWindowEnd: string
  entryActualAt: string | null
  noticeWindowHours: number
  notes: string | null
  createdAt: string
  response: { decision: 'granted' | 'denied'; respondedAt: string; reason: string | null } | null
}

const STATUS_BADGE: Record<string, string> = {
  pending:   'badge-amber',
  granted:   'badge-blue',
  denied:    'badge-muted',
  completed: 'badge-green',
  breached:  'badge-red',
  cancelled: 'badge-muted',
}

export function EntryRequestDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [enteredAt, setEnteredAt] = useState(() => toLocalIsoMinute(new Date()))
  const [notes, setNotes] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<'compliant' | 'breach' | null>(null)

  const { data, isLoading } = useQuery<Detail>(
    ['entry-request', id],
    () => apiGet<Detail>(`/entry-requests/${id}`),
  )

  const recordMut = useMutation(
    (body: { enteredAt: string; notes?: string }) =>
      apiPost<{ outcome: 'compliant' | 'breach' }>(`/entry-requests/${id}/record-entry`, body),
    {
      onSuccess: (res: any) => {
        setOutcome(res?.data?.outcome ?? 'compliant')
        qc.invalidateQueries(['entry-request', id])
      },
      onError: (e: any) => setError(e?.response?.data?.error || 'Failed'),
    },
  )

  const cancelMut = useMutation(
    () => apiPost(`/entry-requests/${id}/cancel`, {}),
    {
      onSuccess: () => qc.invalidateQueries(['entry-request', id]),
      onError: (e: any) => setError(e?.response?.data?.error || 'Failed'),
    },
  )

  if (isLoading || !data) return <div style={{ padding: 32, color: 'var(--text-3)' }}>Loading…</div>
  const r = data as Detail

  const canRecord = r.status === 'granted' || r.status === 'pending'
  const canCancel = r.status === 'pending' || r.status === 'granted' || r.status === 'denied'
  const windowStart = new Date(r.proposedEntryWindowStart)
  const windowEnd   = new Date(r.proposedEntryWindowEnd)

  return (
    <div style={{ maxWidth: 760 }}>
      <div className="page-header">
        <div>
          <button className="btn btn-ghost btn-sm" onClick={() => navigate('/entry-requests')} style={{ marginBottom: 8 }}>
            <ArrowLeft size={14} /> Entry Requests
          </button>
          <h1 style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <DoorOpen size={22} /> Entry Request
            <span className={`badge ${STATUS_BADGE[r.status] || 'badge-muted'}`} style={{ marginLeft: 6 }}>
              {r.status}
            </span>
          </h1>
        </div>
      </div>

      {error && (
        <div className="card" style={{ padding: 12, marginBottom: 16, background: 'rgba(239,68,68,.08)', borderColor: 'rgba(239,68,68,.3)', color: 'var(--red)' }}>
          {error}
        </div>
      )}

      {outcome && (
        <div className="card" style={{
          padding: 16, marginBottom: 16,
          background: outcome === 'compliant' ? 'rgba(34,197,94,.06)' : 'rgba(239,68,68,.06)',
          borderColor: outcome === 'compliant' ? 'rgba(34,197,94,.25)' : 'rgba(239,68,68,.3)',
        }}>
          <div style={{ fontWeight: 700, color: outcome === 'compliant' ? 'var(--green)' : 'var(--red)', marginBottom: 6 }}>
            {outcome === 'compliant' ? 'Entry recorded — compliant' : 'Entry recorded — breach flagged'}
          </div>
          <div style={{ fontSize: '.82rem', color: 'var(--text-2)' }}>
            {outcome === 'compliant'
              ? 'proper_entry_notice_given event emitted to your credit ledger.'
              : 'entry_compliance_breach event emitted to your credit ledger.'}
          </div>
        </div>
      )}

      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <Row label="Reason"><strong style={{ color: 'var(--text-0)' }}>{r.reason}</strong></Row>
        <Row label="Category">{r.reasonCategory}</Row>
        <Row label="Tenant"><span style={{ fontFamily: 'var(--font-mono)' }}>{r.tenantId}</span></Row>
        <Row label="Unit"><span style={{ fontFamily: 'var(--font-mono)' }}>{r.unitId}</span></Row>
        <Row label="Notice given">{fmtDateTime(r.noticeGivenAt)}</Row>
        <Row label="Notice window">
          <span style={{ color: r.noticeWindowHours < 24 ? 'var(--amber)' : 'var(--text-1)' }}>
            {r.noticeWindowHours}h {r.noticeWindowHours < 24 && <AlertTriangle size={12} style={{ verticalAlign: 'middle' }} />}
          </span>
        </Row>
        <Row label="Proposed window">{fmtDateTime(windowStart.toISOString())} → {fmtDateTime(windowEnd.toISOString())}</Row>
        {r.entryActualAt && <Row label="Entered at">{fmtDateTime(r.entryActualAt)}</Row>}
      </div>

      {/* TENANT RESPONSE */}
      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <strong style={{ display: 'block', marginBottom: 10 }}>Tenant response</strong>
        {r.response ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {r.response.decision === 'granted'
              ? <CheckCircle2 size={18} style={{ color: 'var(--green)' }} />
              : <XCircle size={18} style={{ color: 'var(--text-3)' }} />}
            <div>
              <div style={{ fontWeight: 700, color: r.response.decision === 'granted' ? 'var(--green)' : 'var(--text-2)' }}>
                {r.response.decision === 'granted' ? 'Granted' : 'Denied'}
              </div>
              <div style={{ fontSize: '.78rem', color: 'var(--text-3)' }}>{fmtDateTime(r.response.respondedAt)}</div>
              {r.response.reason && <div style={{ fontSize: '.82rem', color: 'var(--text-2)', marginTop: 4 }}>"{r.response.reason}"</div>}
            </div>
          </div>
        ) : (
          <div style={{ color: 'var(--text-3)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <Clock size={14} /> Awaiting tenant response
          </div>
        )}
      </div>

      {/* RECORD ENTRY */}
      {canRecord && (
        <div className="card" style={{ padding: 16, marginBottom: 16 }}>
          <strong style={{ display: 'block', marginBottom: 10 }}>Record actual entry</strong>
          <div style={{ fontSize: '.82rem', color: 'var(--text-2)', marginBottom: 12 }}>
            Posting an entry within the proposed window AND with a granted response
            credits your ledger. Outside the window or without a grant flags a breach.
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 12 }}>
            <div>
              <label style={{ fontSize: '.72rem', color: 'var(--text-2)', display: 'block', marginBottom: 4 }}>Entered at</label>
              <input
                type="datetime-local"
                value={enteredAt}
                onChange={e => setEnteredAt(e.target.value)}
                className="input"
              />
            </div>
            <div>
              <label style={{ fontSize: '.72rem', color: 'var(--text-2)', display: 'block', marginBottom: 4 }}>Notes (optional)</label>
              <input
                type="text"
                value={notes}
                onChange={e => setNotes(e.target.value)}
                className="input"
                placeholder="What you did during the visit"
              />
            </div>
          </div>
          <button
            className="btn btn-primary"
            style={{ marginTop: 12 }}
            onClick={() => recordMut.mutate({
              enteredAt: new Date(enteredAt).toISOString(),
              notes: notes || undefined,
            })}
            disabled={recordMut.isLoading}
          >
            {recordMut.isLoading ? 'Recording…' : 'Record Entry'}
          </button>
        </div>
      )}

      {canCancel && (
        <div className="card" style={{ padding: 12 }}>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => cancelMut.mutate()}
            disabled={cancelMut.isLoading}
            style={{ color: 'var(--red)' }}
          >
            Cancel this request
          </button>
        </div>
      )}
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 12, padding: '6px 0', borderBottom: '1px solid var(--border-0)' }}>
      <div style={{ fontSize: '.72rem', color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.04em' }}>{label}</div>
      <div style={{ color: 'var(--text-1)' }}>{children}</div>
    </div>
  )
}

function fmtDateTime(ts: string): string {
  return new Date(ts).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  })
}

function toLocalIsoMinute(d: Date): string {
  // Format Date for datetime-local input (YYYY-MM-DDTHH:MM)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
