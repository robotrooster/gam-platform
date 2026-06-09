import { useMemo, useState } from 'react'
import { useQuery, useMutation } from 'react-query'
import { Gavel, Search, AlertTriangle } from 'lucide-react'
import { apiGet, apiPost } from '../lib/api'

type Tenant = { id: string; firstName: string; lastName: string; email: string }
type Unit = { id: string; tenantId: string | null; tenantFirst?: string; tenantLast?: string; unitNumber: string; propertyName: string }

const ATTESTABLE_EVENTS: { type: string; label: string; group: string; tone: 'negative' | 'positive'; needsViolationType?: boolean }[] = [
  { type: 'eviction_notice_filed',           label: 'Eviction notice filed',         group: 'Eviction',  tone: 'negative' },
  { type: 'eviction_hearing_scheduled',      label: 'Eviction hearing scheduled',    group: 'Eviction',  tone: 'negative' },
  { type: 'eviction_hearing_continued',      label: 'Eviction hearing continued',    group: 'Eviction',  tone: 'negative' },
  { type: 'eviction_hearing_dismissed',      label: 'Eviction hearing dismissed',    group: 'Eviction',  tone: 'positive' },
  { type: 'eviction_hearing_judgment_issued',label: 'Eviction judgment issued',      group: 'Eviction',  tone: 'negative' },
  { type: 'eviction_settled',                label: 'Eviction settled',              group: 'Eviction',  tone: 'negative' },
  { type: 'eviction_withdrawn',              label: 'Eviction withdrawn',            group: 'Eviction',  tone: 'positive' },
  { type: 'noise_complaint_logged',          label: 'Noise complaint',               group: 'Conduct',   tone: 'negative' },
  { type: 'lease_violation_notice_issued',   label: 'Lease violation notice',        group: 'Conduct',   tone: 'negative', needsViolationType: true },
  { type: 'lease_violation_cured',           label: 'Lease violation cured',         group: 'Conduct',   tone: 'positive' },
  { type: 'property_damage_event_documented',label: 'Property damage documented',    group: 'Property',  tone: 'negative' },
  { type: 'nuisance_event_documented',       label: 'Nuisance event documented',     group: 'Conduct',   tone: 'negative' },
]

const VIOLATION_TYPES = [
  'unauthorized_occupant',
  'unauthorized_pet',
  'noise',
  'property_damage',
  'subleasing',
  'parking',
  'common_area',
  'utilities_misuse',
  'other',
]

export function RecordEventPage() {
  const [search, setSearch] = useState('')
  const [tenantId, setTenantId] = useState<string | null>(null)
  const [eventType, setEventType] = useState<string>('eviction_notice_filed')
  const [occurredAt, setOccurredAt] = useState<string>(() => toLocalIsoMinute(new Date()))
  const [violationType, setViolationType] = useState<string>('other')
  const [notes, setNotes] = useState('')
  const [evidenceUrl, setEvidenceUrl] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const { data: units = [] } = useQuery<Unit[]>('units', () => apiGet<Unit[]>('/units'))
  const { data: tenants = [] } = useQuery<Tenant[]>('tenants-for-attest', () => apiGet<Tenant[]>('/tenants'))

  const tenantOptions = useMemo(() => {
    const idToTenant = new Map<string, Tenant>()
    for (const t of tenants as Tenant[]) idToTenant.set(t.id, t)
    const list: { id: string; label: string; sub: string }[] = []
    for (const u of units as Unit[]) {
      if (u.tenantId && idToTenant.has(u.tenantId)) {
        const t = idToTenant.get(u.tenantId)!
        list.push({ id: u.tenantId, label: `${t.firstName} ${t.lastName}`, sub: `Unit ${u.unitNumber} · ${u.propertyName}` })
      }
    }
    for (const t of tenants as Tenant[]) {
      if (!list.find(x => x.id === t.id)) list.push({ id: t.id, label: `${t.firstName} ${t.lastName}`, sub: t.email })
    }
    if (!search) return list
    const q = search.toLowerCase()
    return list.filter(x => x.label.toLowerCase().includes(q) || x.sub.toLowerCase().includes(q))
  }, [units, tenants, search])

  const selectedTenant = tenantOptions.find(o => o.id === tenantId) || null
  const selectedEvent = ATTESTABLE_EVENTS.find(e => e.type === eventType)!

  const attestMut = useMutation(
    () => apiPost(`/credit/attest`, {
      tenantId,
      eventType,
      occurredAt: new Date(occurredAt).toISOString(),
      // `evidence` content is JSONB passthrough — keys stay snake_case
      evidence: evidenceUrl ? { evidence_url: evidenceUrl } : {},
      notes: notes || undefined,
      violationType: selectedEvent.needsViolationType ? violationType : undefined,
    }),
    {
      onSuccess: () => {
        setSuccess('Event recorded to the credit ledger.')
        setError(null)
        setNotes('')
        setEvidenceUrl('')
        setTimeout(() => setSuccess(null), 5000)
      },
      onError: (e: any) => setError(e?.response?.data?.error || 'Failed to record'),
    },
  )

  const grouped = ATTESTABLE_EVENTS.reduce<Record<string, typeof ATTESTABLE_EVENTS>>((acc, ev) => {
    if (!acc[ev.group]) acc[ev.group] = []
    acc[ev.group].push(ev)
    return acc
  }, {})

  return (
    <div style={{ maxWidth: 720 }}>
      <div className="page-header">
        <div>
          <h1 style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Gavel size={22} /> Record Tenant Event
          </h1>
          <div className="page-sub">
            Manually attest eviction lifecycle events, lease violations, and conduct events.
          </div>
        </div>
      </div>

      <div className="card" style={{ padding: 12, marginBottom: 16, background: 'rgba(245,158,11,.04)', borderColor: 'rgba(245,158,11,.25)' }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
          <AlertTriangle size={16} style={{ color: 'var(--amber)', marginTop: 2, flexShrink: 0 }} />
          <div style={{ fontSize: '.82rem', color: 'var(--text-2)' }}>
            Events you record here go on the tenant's GAM behavioral record
            with <strong>landlord_self_reported_with_evidence</strong>{' '}
            attestation. Tenants can dispute. Provide evidence (court filing,
            police report, photos) where applicable so dispute review is clean.
          </div>
        </div>
      </div>

      {error && <div className="card" style={{ padding: 12, marginBottom: 16, background: 'rgba(239,68,68,.08)', borderColor: 'rgba(239,68,68,.3)', color: 'var(--red)' }}>{error}</div>}
      {success && <div className="card" style={{ padding: 12, marginBottom: 16, background: 'rgba(34,197,94,.06)', borderColor: 'rgba(34,197,94,.25)', color: 'var(--green)' }}>{success}</div>}

      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <Field label="Tenant">
          {selectedTenant ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 10, background: 'var(--bg-3)', borderRadius: 8 }}>
              <div>
                <div style={{ fontWeight: 600, color: 'var(--text-0)' }}>{selectedTenant.label}</div>
                <div style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>{selectedTenant.sub}</div>
              </div>
              <button className="btn btn-ghost btn-sm" onClick={() => setTenantId(null)}>Change</button>
            </div>
          ) : (
            <>
              <div style={{ position: 'relative' }}>
                <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-3)' }} />
                <input
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Search by name or email"
                  className="input"
                  style={{ paddingLeft: 32 }}
                />
              </div>
              {search && (
                <div style={{ maxHeight: 200, overflowY: 'auto', marginTop: 6, border: '1px solid var(--border-0)', borderRadius: 8 }}>
                  {tenantOptions.slice(0, 12).map(opt => (
                    <button
                      key={opt.id}
                      onClick={() => { setTenantId(opt.id); setSearch('') }}
                      style={{ display: 'block', width: '100%', textAlign: 'left', padding: 10, background: 'transparent', border: 'none', borderBottom: '1px solid var(--border-0)', cursor: 'pointer', color: 'var(--text-1)' }}
                    >
                      <div style={{ fontWeight: 600, color: 'var(--text-0)' }}>{opt.label}</div>
                      <div style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>{opt.sub}</div>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </Field>

        <Field label="Event type">
          <select value={eventType} onChange={e => setEventType(e.target.value)} className="input">
            {Object.entries(grouped).map(([group, events]) => (
              <optgroup key={group} label={group}>
                {events.map(ev => (
                  <option key={ev.type} value={ev.type}>
                    {ev.label} {ev.tone === 'positive' ? ' (positive)' : ''}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </Field>

        {selectedEvent.needsViolationType && (
          <Field label="Violation type">
            <select value={violationType} onChange={e => setViolationType(e.target.value)} className="input">
              {VIOLATION_TYPES.map(v => (
                <option key={v} value={v}>{v.replace(/_/g, ' ')}</option>
              ))}
            </select>
          </Field>
        )}

        <Field label="Occurred at">
          <input type="datetime-local" value={occurredAt} onChange={e => setOccurredAt(e.target.value)} className="input" />
        </Field>

        <Field label="Evidence URL (optional)">
          <input
            value={evidenceUrl}
            onChange={e => setEvidenceUrl(e.target.value)}
            className="input"
            placeholder="https://… court filing, police report, photo"
          />
        </Field>

        <Field label="Notes">
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            className="input"
            rows={3}
            placeholder="Context for dispute review and your own records"
          />
        </Field>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <button
            className="btn btn-primary"
            disabled={!tenantId || attestMut.isLoading}
            onClick={() => attestMut.mutate()}
          >
            {attestMut.isLoading ? 'Recording…' : 'Record Event'}
          </button>
        </div>
      </div>
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

function toLocalIsoMinute(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
