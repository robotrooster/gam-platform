import { useState } from 'react'
import { useQuery, useMutation } from 'react-query'
import { useNavigate } from 'react-router-dom'
import { DoorOpen, ArrowLeft, AlertTriangle, Check } from 'lucide-react'
import { apiGet, apiPost } from '../lib/api'
import { LawWarningBanner, type LawFlag } from '../components/LawWarningBanner'

interface CreateResponseData {
  id: string
  notice_window_hours: number
  notice_window_meets_default: boolean
  outside_typical_hours: boolean
  typical_hours_warning: string | null
  state_law_warnings: LawFlag[]
}

export function NewEntryRequestPage() {
  const navigate = useNavigate()
  const [unitId, setUnitId] = useState('')
  const [tenantId, setTenantId] = useState('')
  const [reason, setReason] = useState('')
  const [reasonCategory, setReasonCategory] = useState<'maintenance' | 'inspection' | 'showing' | 'emergency' | 'other'>('maintenance')
  const [windowStart, setWindowStart] = useState('')
  const [windowEnd, setWindowEnd] = useState('')
  const [error, setError] = useState<string | null>(null)
  // S477: post-create result. Held in state when the backend surfaces
  // warnings (state-law mismatch or outside-typical-hours flag) so the
  // landlord can read them before navigating to the request detail.
  const [submittedResult, setSubmittedResult] = useState<CreateResponseData | null>(null)

  const { data: units = [] } = useQuery<any[]>('units', () => apiGet<any[]>('/units'))
  const { data: tenants = [] } = useQuery<any[]>('tenants', () => apiGet<any[]>('/tenants'))

  const createMut = useMutation(
    (body: any) => apiPost<CreateResponseData>('/entry-requests', body),
    {
      onSuccess: (res: any) => {
        const data: CreateResponseData = res.data
        const hasWarnings = data.outside_typical_hours
          || (data.state_law_warnings && data.state_law_warnings.length > 0)
        if (hasWarnings) {
          setSubmittedResult(data)
        } else {
          navigate(`/entry-requests/${data.id}`)
        }
      },
      onError: (e: any) => setError(e?.response?.data?.error || 'Failed'),
    },
  )

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!unitId || !tenantId) { setError('Unit and tenant required'); return }
    if (!windowStart || !windowEnd) { setError('Window start/end required'); return }
    if (new Date(windowEnd) <= new Date(windowStart)) { setError('Window end must be after start'); return }
    createMut.mutate({
      unitId: unitId,
      tenantId: tenantId,
      reason,
      reasonCategory: reasonCategory,
      proposedEntryWindowStart: new Date(windowStart).toISOString(),
      proposedEntryWindowEnd:   new Date(windowEnd).toISOString(),
    })
  }

  // Calculate hours-of-notice from now to window-start so the user can see
  // whether they're inside the standard 24h.
  const hoursOfNotice = windowStart
    ? Math.round((new Date(windowStart).getTime() - Date.now()) / 3_600_000)
    : null

  return (
    <div style={{ maxWidth: 720 }}>
      <div className="page-header">
        <div>
          <button className="btn btn-ghost btn-sm" onClick={() => navigate('/entry-requests')} style={{ marginBottom: 8 }}>
            <ArrowLeft size={14} /> Entry Requests
          </button>
          <h1 style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <DoorOpen size={22} /> New Entry Request
          </h1>
        </div>
      </div>

      {submittedResult ? (
        <div className="card" style={{ padding: 24 }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            color: 'var(--green)', fontWeight: 600, fontSize: '.95rem',
            marginBottom: 16,
          }}>
            <Check size={18} /> Entry request sent.
          </div>

          {submittedResult.outside_typical_hours && submittedResult.typical_hours_warning && (
            <div style={{
              background: 'rgba(245, 158, 11, 0.08)',
              border: '1px solid rgba(245, 158, 11, 0.4)',
              borderRadius: 8, padding: '12px 14px', marginBottom: 12,
              display: 'flex', gap: 10, alignItems: 'flex-start',
            }}>
              <AlertTriangle size={16} style={{ color: 'var(--amber, #f59e0b)', flexShrink: 0, marginTop: 2 }} />
              <div style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--text-0)' }}>
                <div style={{
                  fontWeight: 700, color: 'var(--amber, #f59e0b)',
                  fontSize: 12, textTransform: 'uppercase',
                  letterSpacing: 0.5, marginBottom: 6,
                }}>
                  Outside typical hours
                </div>
                {submittedResult.typical_hours_warning}
              </div>
            </div>
          )}

          <LawWarningBanner warnings={submittedResult.state_law_warnings} />

          <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 8 }}>
            Your notice was sent to the tenant. The note(s) above are
            informational — no action required.
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
            <button className="btn btn-ghost" onClick={() => navigate('/entry-requests')}>
              Back to list
            </button>
            <button className="btn btn-primary" onClick={() => navigate(`/entry-requests/${submittedResult.id}`)}>
              View request
            </button>
          </div>
        </div>
      ) : (

      <form onSubmit={onSubmit} className="card" style={{ padding: 24 }}>
        {error && (
          <div style={{ background: 'rgba(239,68,68,.08)', border: '1px solid rgba(239,68,68,.3)', borderRadius: 8, padding: 12, color: 'var(--red)', marginBottom: 16 }}>
            {error}
          </div>
        )}

        <Field label="Unit">
          <select value={unitId} onChange={e => setUnitId(e.target.value)} className="input" required>
            <option value="">— pick a unit —</option>
            {(units as any[]).map(u => (
              <option key={u.id} value={u.id}>{u.unitNumber} — {u.propertyName}</option>
            ))}
          </select>
        </Field>

        <Field label="Tenant">
          <select value={tenantId} onChange={e => setTenantId(e.target.value)} className="input" required>
            <option value="">— pick a tenant —</option>
            {(tenants as any[]).map(t => (
              <option key={t.id} value={t.id}>{t.firstName} {t.lastName}</option>
            ))}
          </select>
        </Field>

        <Field label="Reason category">
          <select value={reasonCategory} onChange={e => setReasonCategory(e.target.value as any)} className="input" required>
            <option value="maintenance">Maintenance</option>
            <option value="inspection">Inspection</option>
            <option value="showing">Showing</option>
            <option value="emergency">Emergency</option>
            <option value="other">Other</option>
          </select>
        </Field>

        <Field label="Reason details">
          <textarea
            value={reason}
            onChange={e => setReason(e.target.value)}
            className="input"
            rows={3}
            placeholder="What you'll be doing during the visit (visible to tenant)"
            required
          />
        </Field>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Window start">
            <input type="datetime-local" value={windowStart} onChange={e => setWindowStart(e.target.value)} className="input" required />
          </Field>
          <Field label="Window end">
            <input type="datetime-local" value={windowEnd} onChange={e => setWindowEnd(e.target.value)} className="input" required />
          </Field>
        </div>

        {hoursOfNotice !== null && (
          <div
            className="card"
            style={{
              padding: 12,
              marginTop: 4,
              background: hoursOfNotice < 24
                ? 'rgba(245,158,11,.06)'
                : 'rgba(34,197,94,.04)',
              borderColor: hoursOfNotice < 24
                ? 'rgba(245,158,11,.3)'
                : 'rgba(34,197,94,.25)',
            }}
          >
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: '.85rem',
              color: hoursOfNotice < 24 ? 'var(--amber)' : 'var(--green)',
              fontWeight: 600,
            }}>
              {hoursOfNotice < 24 && <AlertTriangle size={14} />}
              {hoursOfNotice}h notice from now
            </div>
            <div style={{ fontSize: '.78rem', color: 'var(--text-2)', marginTop: 4 }}>
              {hoursOfNotice < 24
                ? 'Below the standard 24h notice. Send only if circumstances justify it (e.g. emergency).'
                : 'Meets standard 24h notice window.'}
            </div>
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button type="button" className="btn btn-ghost" onClick={() => navigate('/entry-requests')}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={createMut.isLoading}>
            {createMut.isLoading ? 'Sending…' : 'Send Notice'}
          </button>
        </div>
      </form>
      )}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{ display: 'block', fontSize: '.72rem', fontWeight: 600, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 6 }}>
        {label}
      </label>
      {children}
    </div>
  )
}
