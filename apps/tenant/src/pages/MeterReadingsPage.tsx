import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { Gauge, ChevronRight } from 'lucide-react'
import { apiGet, apiPost, apiUpload } from '../lib/api'
import { toast } from '../components/dialogs'
import { ReadingWalkModal } from '../../../../packages/shared-ui/MeterWalk'

// S652 (Nic): "Curtis is the work trade person for Mattoon… did we give him
// permission to initiate a meter read? How does he access that from the
// tenant portal?" The API has let a work trader with "Read meters" on their
// agreement take the same walk the front desk takes (utility.ts,
// requireMeterReader) — but the tenant portal had no screen for it. This is
// that screen: the property's reading run, started here if none is open, and
// the same blind walk the landlord's Utilities page uses.
const walkApi = { get: apiGet, post: apiPost, upload: (url: string, form: FormData) => apiUpload(url, form).then(d => ({ data: d })) }
const monthLabel = (cycle: any) => new Date(String(cycle).slice(0, 10) + 'T00:00:00Z')
  .toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })

export function MeterReadingsPage() {
  const qc = useQueryClient()
  const { data: agreement, isLoading } = useQuery<any>('work-trade-nav', () => apiGet('/tenants/work-trade'))
  const canRead = Array.isArray(agreement?.fieldPermissions) && agreement.fieldPermissions.includes('read_meters')
  const propertyId = agreement?.propertyId as string | undefined
  const { data: runs = [] } = useQuery<any[]>(
    ['reading-runs', propertyId],
    () => apiGet(`/utility/reading-runs?propertyId=${propertyId}`),
    { enabled: !!propertyId && canRead },
  )
  const [walkRun, setWalkRun] = useState<any | null>(null)
  const openRun = (runs as any[]).find(r => r.status === 'open' || r.status === 'double_check') || null
  const startRun = useMutation(
    () => apiPost('/utility/reading-runs', { propertyId }),
    { onSuccess: (r: any) => { qc.invalidateQueries(['reading-runs', propertyId]); setWalkRun(r?.data ?? r) },
      onError: (e: any) => toast.error(e?.response?.data?.error || 'Could not start a reading run') },
  )

  if (isLoading) return <div className="card" style={{ padding: 18, fontSize: '.85rem', color: 'var(--t2)' }}>Loading…</div>
  if (!agreement || !canRead) {
    return <div className="card" style={{ padding: 18, fontSize: '.85rem', color: 'var(--t2)' }}>
      Reading meters is not part of your work trade agreement.
    </div>
  }
  const done = (runs as any[]).filter(r => r.status === 'completed').slice(0, 6)
  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title"><Gauge size={20} style={{ verticalAlign: '-3px', marginRight: 8 }} />Meter readings</h1>
          <p className="page-subtitle">{agreement.propertyName} — part of your work trade</p>
        </div>
      </div>

      {openRun ? (
        <div className="card" style={{ padding: 18, marginBottom: 16 }}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>
            {openRun.status === 'double_check' ? 'Verification walk' : 'Meter readings due'} — {monthLabel(openRun.billingCycleMonth)}
          </div>
          <div style={{ fontSize: '.82rem', color: 'var(--t2)', marginBottom: 12 }}>
            {Number(openRun.metersRead ?? 0)} of {Number(openRun.metersTotal ?? 0)} read. Enter each meter exactly as its face shows it — nothing previous is shown on purpose.
          </div>
          <button className="btn btn-primary" onClick={() => setWalkRun(openRun)}>
            {openRun.status === 'double_check' ? 'Start verification' : (Number(openRun.metersRead ?? 0) > 0 ? 'Continue reading' : 'Start reading')} <ChevronRight size={14} />
          </button>
        </div>
      ) : (
        <div className="card" style={{ padding: 18, marginBottom: 16 }}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>No reading run is open</div>
          <div style={{ fontSize: '.82rem', color: 'var(--t2)', marginBottom: 12 }}>
            The month&apos;s run opens on its own near the end of the cycle. Start one now if the office asked you to read early.
          </div>
          <button className="btn btn-primary" disabled={startRun.isLoading} onClick={() => startRun.mutate()}>
            {startRun.isLoading ? 'Starting…' : 'Start a reading run'}
          </button>
        </div>
      )}

      {done.length > 0 && (
        <div className="card" style={{ padding: 0 }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-1)', fontWeight: 600, fontSize: '.88rem' }}>Past runs</div>
          {done.map(r => (
            <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 16px', borderBottom: '1px solid var(--border-1)', fontSize: '.82rem' }}>
              <span>{monthLabel(r.billingCycleMonth)}</span>
              <span style={{ color: 'var(--t2)' }}>{Number(r.metersRead ?? 0)} of {Number(r.metersTotal ?? 0)} read</span>
            </div>
          ))}
        </div>
      )}

      {walkRun && (
        <ReadingWalkModal run={walkRun} mode={walkRun.status === 'double_check' ? 'verify' : 'read'} api={walkApi}
          onClose={() => { setWalkRun(null); qc.invalidateQueries(['reading-runs', propertyId]) }} />
      )}
    </div>
  )
}
