import { useQuery } from 'react-query'
import { useParams, useNavigate } from 'react-router-dom'
import { Film, ArrowLeft, Video } from 'lucide-react'
import { apiGet } from '../lib/api'

type LifecycleVideo = {
  id: string
  title: string | null
  url: string
  thumbnailUrl: string | null
  durationSeconds: number | null
  capturedLive: boolean
  uploadedAt: string
}
type Stage = {
  id: string
  inspectionType: 'move_in' | 'move_out' | 'periodic' | 'turnover'
  status: string
  scheduledFor: string | null
  conductedAt: string | null
  finalizedAt: string | null
  createdAt: string
  videos: LifecycleVideo[]
}
type Lifecycle = {
  unit: { id: string; unitNumber: string | null }
  stages: Stage[]
}

const STAGE_LABEL: Record<string, string> = {
  move_in: 'Move-in',
  move_out: 'Move-out',
  turnover: 'Turnover (clean / repair)',
  periodic: 'Periodic',
}
const STAGE_DOT: Record<string, string> = {
  move_in: 'var(--green)',
  move_out: 'var(--amber)',
  turnover: 'var(--gold)',
  periodic: 'var(--text-3)',
}

export function UnitLifecyclePage() {
  const { unitId } = useParams<{ unitId: string }>()
  const navigate = useNavigate()

  const { data, isLoading } = useQuery<Lifecycle>(
    ['unit-lifecycle', unitId],
    () => apiGet<Lifecycle>(`/inspections/unit/${unitId}/lifecycle`),
  )

  if (isLoading || !data) return <div style={{ padding: 32, color: 'var(--text-3)' }}>Loading…</div>

  const apiUrl = (import.meta as any).env.VITE_API_URL
  const totalVideos = data.stages.reduce((n, s) => n + s.videos.length, 0)

  return (
    <div style={{ maxWidth: 960 }}>
      <div className="page-header">
        <div>
          <button className="btn btn-ghost btn-sm" onClick={() => navigate(-1)} style={{ marginBottom: 8 }}>
            <ArrowLeft size={14} /> Back
          </button>
          <h1 style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Film size={22} />
            Unit {data.unit.unitNumber || data.unit.id.slice(0, 8)} — video history
          </h1>
          <div className="page-sub">
            {data.stages.length} inspection{data.stages.length === 1 ? '' : 's'} · {totalVideos} video{totalVideos === 1 ? '' : 's'} · oldest first
          </div>
        </div>
      </div>

      {data.stages.length === 0 ? (
        <div className="card" style={{ padding: 24, textAlign: 'center', color: 'var(--text-3)' }}>
          No inspections on this unit yet.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {data.stages.map(stage => (
            <div key={stage.id} className="card" style={{ padding: 0 }}>
              <div style={{ padding: 16, borderBottom: '1px solid var(--border-0)', display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ width: 10, height: 10, borderRadius: '50%', background: STAGE_DOT[stage.inspectionType] || 'var(--text-3)' }} />
                <strong>{STAGE_LABEL[stage.inspectionType] || stage.inspectionType}</strong>
                <span className="badge badge-muted">{stage.status.replace('_', ' ')}</span>
                <span style={{ marginLeft: 'auto', fontSize: '.78rem', color: 'var(--text-3)' }}>
                  {fmtDate(stage.conductedAt || stage.scheduledFor || stage.createdAt)}
                </span>
              </div>
              {stage.videos.length === 0 ? (
                <div style={{ padding: 16, fontSize: '.82rem', color: 'var(--text-3)', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Video size={14} /> No video for this stage.
                </div>
              ) : (
                <div style={{ padding: 16, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 16 }}>
                  {stage.videos.map(v => (
                    <div key={v.id}>
                      <video
                        controls
                        preload="metadata"
                        src={apiUrl + v.url}
                        style={{ width: '100%', borderRadius: 8, background: '#000', aspectRatio: '16/9' }}
                      />
                      <div style={{ marginTop: 6, fontSize: '.78rem', color: 'var(--text-2)', display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span>{v.title || fmtDate(v.uploadedAt)}</span>
                        {v.capturedLive && <span className="badge badge-green">live capture</span>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function fmtDate(s: string | null) {
  return s ? new Date(s).toLocaleDateString() : '—'
}
