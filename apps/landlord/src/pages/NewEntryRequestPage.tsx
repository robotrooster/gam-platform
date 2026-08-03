import { useState } from 'react'
import { useQuery, useMutation } from 'react-query'
import { useNavigate } from 'react-router-dom'
import { DoorOpen, ArrowLeft, AlertTriangle, Check, Wrench, ClipboardCheck } from 'lucide-react'
import { apiGet, apiPost } from '../lib/api'
import { humanize } from '@gam/shared'
import { LawWarningBanner, type LawFlag } from '../components/LawWarningBanner'

interface CreateResponseData {
  id: string
  noticeWindowHours: number
  noticeWindowMeetsDefault: boolean
  outsideTypicalHours: boolean
  typicalHoursWarning: string | null
  stateLawWarnings: LawFlag[]
}

export function NewEntryRequestPage() {
  const navigate = useNavigate()
  // S571: entry is anchored to a real maintenance call OR a scheduled
  // inspection — the unit/tenant/reason all derive from it. No free reason.
  const [anchorType, setAnchorType] = useState<'maintenance' | 'inspection'>('maintenance')
  const [maintenanceRequestId, setMaintenanceRequestId] = useState('')
  const [inspectionId, setInspectionId] = useState('')
  const [windowStart, setWindowStart] = useState('')
  const [windowEnd, setWindowEnd] = useState('')
  const [error, setError] = useState<string | null>(null)
  // S477: post-create result. Held in state when the backend surfaces
  // warnings (state-law mismatch or outside-typical-hours flag) so the
  // landlord can read them before navigating to the request detail.
  const [submittedResult, setSubmittedResult] = useState<CreateResponseData | null>(null)

  // Open maintenance calls the landlord could enter for.
  const { data: maintenance = [] } = useQuery<any[]>('entry-maint', () => apiGet<any[]>('/maintenance'))
  const openMaint = (maintenance as any[]).filter(m => m.status !== 'completed' && m.status !== 'cancelled')
  // Scheduled / in-progress inspections that need access.
  const { data: inspections = [] } = useQuery<any[]>('entry-inspections', () => apiGet<any[]>('/inspections'))
  const openInspections = (inspections as any[]).filter(i => i.status !== 'finalized' && i.status !== 'cancelled')

  const createMut = useMutation(
    (body: any) => apiPost<CreateResponseData>('/entry-requests', body),
    {
      onSuccess: (res: any) => {
        const data: CreateResponseData = res.data
        const hasWarnings = data.outsideTypicalHours
          || (data.stateLawWarnings && data.stateLawWarnings.length > 0)
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
    const anchorId = anchorType === 'maintenance' ? maintenanceRequestId : inspectionId
    if (!anchorId) { setError(`Pick a ${anchorType === 'maintenance' ? 'maintenance call' : 'scheduled inspection'} to enter for`); return }
    if (!windowStart || !windowEnd) { setError('Window start/end required'); return }
    if (new Date(windowEnd) <= new Date(windowStart)) { setError('Window end must be after start'); return }
    createMut.mutate({
      ...(anchorType === 'maintenance' ? { maintenanceRequestId } : { inspectionId }),
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

          {submittedResult.outsideTypicalHours && submittedResult.typicalHoursWarning && (
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
                {submittedResult.typicalHoursWarning}
              </div>
            </div>
          )}

          <LawWarningBanner warnings={submittedResult.stateLawWarnings} />

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

        <div style={{ fontSize: '.78rem', color: 'var(--text-2)', marginBottom: 14, lineHeight: 1.5 }}>
          Entry is tied to a specific reason the tenant can already see — pick a maintenance call or a scheduled inspection. The unit and tenant come from it automatically.
        </div>

        <Field label="Entry for">
          <div style={{ display: 'flex', gap: 8 }}>
            {([['maintenance', 'Maintenance call', Wrench], ['inspection', 'Scheduled inspection', ClipboardCheck]] as const).map(([val, label, Icon]) => (
              <button key={val} type="button" onClick={() => { setAnchorType(val); setError(null) }}
                style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, padding: '10px', borderRadius: 8, cursor: 'pointer', fontSize: '.82rem', fontWeight: 600,
                  border: `1px solid ${anchorType === val ? 'var(--gold)' : 'var(--border-0)'}`,
                  background: anchorType === val ? 'rgba(201,162,39,.08)' : 'var(--bg-2)',
                  color: anchorType === val ? 'var(--gold)' : 'var(--text-3)' }}>
                <Icon size={15} /> {label}
              </button>
            ))}
          </div>
        </Field>

        {anchorType === 'maintenance' ? (
          <Field label="Which maintenance call">
            <select value={maintenanceRequestId} onChange={e => setMaintenanceRequestId(e.target.value)} className="input" required>
              <option value="">— pick an open maintenance call —</option>
              {openMaint.map(m => (
                <option key={m.id} value={m.id}>
                  Unit {m.unitNumber || '—'} · {m.title || 'Request'} ({humanize(m.status)})
                </option>
              ))}
            </select>
            {openMaint.length === 0 && (
              <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 6 }}>
                No open maintenance calls. Entry for a repair starts from a maintenance request.
              </div>
            )}
          </Field>
        ) : (
          <Field label="Which inspection">
            <select value={inspectionId} onChange={e => setInspectionId(e.target.value)} className="input" required>
              <option value="">— pick a scheduled inspection —</option>
              {openInspections.map(i => (
                <option key={i.id} value={i.id}>
                  Unit {i.unitNumber || '—'} · {humanize(i.inspectionType)}{i.scheduledFor ? ` · ${new Date(i.scheduledFor).toLocaleDateString()}` : ''}
                </option>
              ))}
            </select>
            {openInspections.length === 0 && (
              <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 6 }}>
                No scheduled inspections. Create one from the Inspections page first.
              </div>
            )}
          </Field>
        )}

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
