import { useState, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { useParams, useNavigate } from 'react-router-dom'
import {
  ClipboardCheck, ArrowLeft, Plus, Camera, Video, Film,
  CheckCircle2, FileSignature, Calendar,
} from 'lucide-react'
import { api, apiGet, apiPatch, apiPost } from '../lib/api'
import { CameraCapture } from '../components/CameraCapture'
import { AuthedImg, AuthedVideo } from '../components/AuthedMedia'

type Item = {
  id: string
  area: string
  itemLabel: string
  condition: 'good' | 'fair' | 'damaged' | 'missing' | 'na'
  notes: string | null
  estimatedRepairCost: string | null
}
type Photo = {
  id: string
  itemId: string | null
  photoUrl: string
  caption: string | null
  capturedLive: boolean
  uploadedBy: string
  uploadedAt: string
}
type Sig = { signerUserId: string; signerRole: string; signedAt: string }
type Vid = {
  id: string
  title: string | null
  videoUrl: string
  thumbnailUrl: string | null
  durationSeconds: number | null
  capturedLive: boolean
  uploadedAt: string
}
type Detail = {
  id: string
  unitId: string
  leaseId: string | null
  tenantId: string | null
  landlordId: string
  inspectionType: 'move_in' | 'move_out' | 'periodic' | 'turnover'
  status: string
  comparisonInspectionId: string | null
  scheduledFor: string | null
  finalizedAt: string | null
  notes: string | null
  items: Item[]
  photos: Photo[]
  signatures: Sig[]
}

const COND_BADGE: Record<string, string> = {
  good:     'badge-green',
  fair:     'badge-amber',
  damaged:  'badge-red',
  missing:  'badge-red',
  na:       'badge-muted',
}

const STATUS_BADGE: Record<string, string> = {
  draft:           'badge-muted',
  tenant_signed:   'badge-amber',
  landlord_signed: 'badge-amber',
  finalized:       'badge-green',
  disputed:        'badge-red',
  cancelled:       'badge-muted',
}

export function InspectionDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)
  const videoRef = useRef<HTMLInputElement>(null)
  const [newItem, setNewItem] = useState({ area: '', itemLabel: '', condition: 'good' as Item['condition'], notes: '' })
  const [error, setError] = useState<string | null>(null)
  const [finalizeResult, setFinalizeResult] = useState<any>(null)
  const [showReschedule, setShowReschedule] = useState(false)
  const [camera, setCamera] = useState<null | 'photo' | 'video'>(null)

  const { data, isLoading } = useQuery<Detail>(
    ['inspection', id],
    () => apiGet<Detail>(`/inspections/${id}`),
  )

  // Walkthrough videos live on a separate endpoint (not in the detail payload).
  const { data: videos } = useQuery<Vid[]>(
    ['inspection-videos', id],
    () => apiGet<Vid[]>(`/inspections/${id}/videos`),
  )

  const addItemMut = useMutation(
    (body: any) => apiPost(`/inspections/${id}/items`, body),
    {
      onSuccess: () => {
        qc.invalidateQueries(['inspection', id])
        setNewItem({ area: '', itemLabel: '', condition: 'good', notes: '' })
      },
      onError: (e: any) => setError(e?.response?.data?.error || 'Failed'),
    },
  )

  const photoMut = useMutation(
    ({ file, live }: { file: File; live?: boolean }) => {
      const fd = new FormData()
      fd.append('file', file)
      if (live) fd.append('capturedLive', 'true')
      return api.post(`/inspections/${id}/photos`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      }).then(r => r.data)
    },
    {
      onSuccess: () => qc.invalidateQueries(['inspection', id]),
      onError: (e: any) => setError(e?.response?.data?.error || 'Upload failed'),
    },
  )

  const videoMut = useMutation(
    ({ file, live }: { file: File; live?: boolean }) => {
      const fd = new FormData()
      fd.append('file', file)
      if (live) fd.append('capturedLive', 'true')
      return api.post(`/inspections/${id}/videos`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      }).then(r => r.data)
    },
    {
      onSuccess: () => qc.invalidateQueries(['inspection-videos', id]),
      onError: (e: any) => setError(e?.response?.data?.error || 'Video upload failed'),
    },
  )

  const signMut = useMutation(
    () => apiPost(`/inspections/${id}/sign`),
    {
      onSuccess: () => qc.invalidateQueries(['inspection', id]),
      onError: (e: any) => setError(e?.response?.data?.error || 'Sign failed'),
    },
  )

  const finalizeMut = useMutation(
    () => apiPost<any>(`/inspections/${id}/finalize`),
    {
      onSuccess: (res: any) => {
        setFinalizeResult(res?.data ?? res)
        qc.invalidateQueries(['inspection', id])
      },
      onError: (e: any) => setError(e?.response?.data?.error || 'Finalize failed'),
    },
  )

  const rescheduleMut = useMutation(
    (newScheduledFor: string | null) => apiPatch(`/inspections/${id}`, { scheduledFor: newScheduledFor }),
    {
      onSuccess: () => {
        qc.invalidateQueries(['inspection', id])
        setShowReschedule(false)
      },
      onError: (e: any) => setError(e?.response?.data?.error || 'Reschedule failed'),
    },
  )

  if (isLoading || !data) return <div style={{ padding: 32, color: 'var(--text-3)' }}>Loading…</div>

  const insp = data as Detail
  const editable = insp.status === 'draft'
  const hasTenantSig = insp.signatures.some(s => s.signerRole === 'tenant')
  const hasLandlordSig = insp.signatures.some(s => s.signerRole === 'landlord' || s.signerRole === 'inspector')
  const canFinalize = insp.status === 'landlord_signed'

  return (
    <div style={{ maxWidth: 960 }}>
      <div className="page-header">
        <div>
          <button className="btn btn-ghost btn-sm" onClick={() => navigate('/inspections')} style={{ marginBottom: 8 }}>
            <ArrowLeft size={14} /> Inspections
          </button>
          <h1 style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <ClipboardCheck size={22} />
            {labelType(insp.inspectionType)} Inspection
            <span className={`badge ${STATUS_BADGE[insp.status] || 'badge-muted'}`} style={{ marginLeft: 6 }}>
              {insp.status.replace('_', ' ')}
            </span>
          </h1>
          <div className="page-sub">
            Unit {insp.unitId.slice(0, 8)}…
            {insp.tenantId && <> · Tenant {insp.tenantId.slice(0, 8)}…</>}
            {insp.comparisonInspectionId && <> · Comparing against {insp.comparisonInspectionId.slice(0, 8)}…</>}
          </div>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => navigate(`/inspections/unit/${insp.unitId}/lifecycle`)}
            style={{ marginTop: 8 }}
          >
            <Film size={14} /> Unit video history
          </button>
          {insp.status !== 'finalized' && insp.status !== 'cancelled' && (
            <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8, fontSize: '.85rem' }}>
              <Calendar size={14} style={{ color: 'var(--text-3)' }} />
              <span style={{ color: 'var(--text-2)' }}>
                {insp.scheduledFor
                  ? `Scheduled for ${new Date(insp.scheduledFor).toLocaleString()}`
                  : 'Not scheduled'}
              </span>
              <button className="btn btn-ghost btn-sm" onClick={() => setShowReschedule(true)} style={{ padding: '2px 8px' }}>
                {insp.scheduledFor ? 'Reschedule' : 'Set time'}
              </button>
            </div>
          )}
        </div>
      </div>

      {showReschedule && (
        <RescheduleModal
          current={insp.scheduledFor}
          onClose={() => setShowReschedule(false)}
          onSave={(v) => rescheduleMut.mutate(v)}
          saving={rescheduleMut.isLoading}
        />
      )}

      {camera && (
        <CameraCapture
          mode={camera}
          onClose={() => setCamera(null)}
          onCapture={(file) => (camera === 'photo' ? photoMut : videoMut).mutate({ file, live: true })}
        />
      )}

      {error && (
        <div className="card" style={{ padding: 12, marginBottom: 16, background: 'rgba(239,68,68,.08)', borderColor: 'rgba(239,68,68,.3)', color: 'var(--red)' }}>
          {error}
        </div>
      )}

      {finalizeResult && (
        <div className="card" style={{ padding: 16, marginBottom: 16, background: 'rgba(34,197,94,.06)', borderColor: 'rgba(34,197,94,.25)' }}>
          <div style={{ fontWeight: 700, color: 'var(--green)', marginBottom: 6 }}>Inspection finalized</div>
          <div style={{ fontSize: '.82rem', color: 'var(--text-2)' }}>
            {insp.inspectionType === 'move_out' && (
              <>
                Comparison: <strong>{finalizeResult.matchesMoveIn ? 'matches move-in' : 'damage documented'}</strong>.&nbsp;
              </>
            )}
            Photos attached: {finalizeResult.photoCount}. Credit ledger events emitted.
          </div>
        </div>
      )}

      {/* CHECKLIST */}
      <div className="card" style={{ padding: 0, marginBottom: 16 }}>
        <div style={{ padding: 16, borderBottom: '1px solid var(--border-0)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <strong>Checklist ({insp.items.length})</strong>
          {!editable && <span className="badge badge-muted">read-only</span>}
        </div>
        {insp.items.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-3)' }}>No items yet.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
          <table className="data-table" style={{ width: '100%', minWidth: 700 }}>
            <thead>
              <tr>
                <th>Area</th>
                <th>Item</th>
                <th>Condition</th>
                <th>Notes</th>
                <th>Repair $</th>
              </tr>
            </thead>
            <tbody>
              {insp.items.map(it => (
                <tr key={it.id}>
                  <td>{it.area}</td>
                  <td><strong>{it.itemLabel}</strong></td>
                  <td><span className={`badge ${COND_BADGE[it.condition]}`}>{it.condition}</span></td>
                  <td style={{ fontSize: '.8rem', color: 'var(--text-2)' }}>{it.notes || '—'}</td>
                  <td>{it.estimatedRepairCost ? `$${Number(it.estimatedRepairCost).toFixed(2)}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
        {editable && (
          <div style={{ padding: 16, borderTop: '1px solid var(--border-0)', background: 'var(--bg-1)' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr 120px 1fr auto', gap: 8 }}>
              <input
                placeholder="Area (e.g. kitchen)"
                value={newItem.area}
                onChange={e => setNewItem({ ...newItem, area: e.target.value })}
                className="input"
              />
              <input
                placeholder="Item (e.g. Refrigerator)"
                value={newItem.itemLabel}
                onChange={e => setNewItem({ ...newItem, itemLabel: e.target.value })}
                className="input"
              />
              <select
                value={newItem.condition}
                onChange={e => setNewItem({ ...newItem, condition: e.target.value as Item['condition'] })}
                className="input"
              >
                <option value="good">good</option>
                <option value="fair">fair</option>
                <option value="damaged">damaged</option>
                <option value="missing">missing</option>
                <option value="na">n/a</option>
              </select>
              <input
                placeholder="Notes (optional)"
                value={newItem.notes}
                onChange={e => setNewItem({ ...newItem, notes: e.target.value })}
                className="input"
              />
              <button
                className="btn btn-primary btn-sm"
                onClick={() => {
                  if (!newItem.area || !newItem.itemLabel) { setError('Area and item are required'); return }
                  addItemMut.mutate(newItem)
                }}
                disabled={addItemMut.isLoading}
              >
                <Plus size={14} /> Add
              </button>
            </div>
            <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 6 }}>
              Same (area, item) updates the existing row; condition can be revised before sign.
            </div>
          </div>
        )}
      </div>

      {/* PHOTOS */}
      <div className="card" style={{ padding: 0, marginBottom: 16 }}>
        <div style={{ padding: 16, borderBottom: '1px solid var(--border-0)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <strong>Photos ({insp.photos.length})</strong>
          {insp.status !== 'finalized' && insp.status !== 'cancelled' && (
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                style={{ display: 'none' }}
                onChange={e => {
                  const f = e.target.files?.[0]
                  if (f) photoMut.mutate({ file: f })
                  e.target.value = ''
                }}
              />
              <button className="btn btn-primary btn-sm" onClick={() => setCamera('photo')} disabled={photoMut.isLoading}>
                <Camera size={14} /> Take photo
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => fileRef.current?.click()} disabled={photoMut.isLoading}>
                {photoMut.isLoading ? 'Uploading…' : 'Upload'}
              </button>
            </div>
          )}
        </div>
        {insp.photos.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-3)' }}>No photos.</div>
        ) : (
          <div style={{ padding: 16, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 12 }}>
            {insp.photos.map(p => (
              <div key={p.id} style={{ position: 'relative' }}>
                <div style={{ aspectRatio: '1/1', borderRadius: 8, overflow: 'hidden', background: 'var(--bg-3)' }}>
                  <AuthedImg path={p.photoUrl} alt={p.caption || ''}
                             style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 8 }} />
                </div>
                {p.capturedLive && (
                  <span className="badge badge-green" style={{ position: 'absolute', top: 6, left: 6 }}>live</span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* VIDEOS — in-house walkthrough clips (the unit's "mini-YouTube") */}
      <div className="card" style={{ padding: 0, marginBottom: 16 }}>
        <div style={{ padding: 16, borderBottom: '1px solid var(--border-0)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <strong>Walkthrough videos ({videos?.length ?? 0})</strong>
          {insp.status !== 'finalized' && insp.status !== 'cancelled' && (
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                ref={videoRef}
                type="file"
                accept="video/mp4,video/quicktime,video/webm"
                style={{ display: 'none' }}
                onChange={e => {
                  const f = e.target.files?.[0]
                  if (f) videoMut.mutate({ file: f })
                  e.target.value = ''
                }}
              />
              <button className="btn btn-primary btn-sm" onClick={() => setCamera('video')} disabled={videoMut.isLoading}>
                <Video size={14} /> Record video
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => videoRef.current?.click()} disabled={videoMut.isLoading}>
                {videoMut.isLoading ? 'Uploading…' : 'Upload'}
              </button>
            </div>
          )}
        </div>
        {!videos || videos.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-3)' }}>No videos yet. Walkthrough clips are kept permanently — they can’t be deleted once added.</div>
        ) : (
          <div style={{ padding: 16, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 16 }}>
            {videos.map(v => (
              <div key={v.id}>
                <AuthedVideo
                  path={v.videoUrl}
                  style={{ width: '100%', borderRadius: 8, background: '#000', aspectRatio: '16/9' }}
                />
                <div style={{ marginTop: 6, fontSize: '.78rem', color: 'var(--text-2)', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span>{v.title || new Date(v.uploadedAt).toLocaleDateString()}</span>
                  {v.capturedLive && <span className="badge badge-green">live capture</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* SIGNATURES */}
      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <strong style={{ display: 'block', marginBottom: 12 }}>Sign-off</strong>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div style={{ padding: 12, border: '1px solid var(--border-0)', borderRadius: 8 }}>
            <div style={{ fontSize: '.72rem', color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.05em' }}>Tenant</div>
            <div style={{ marginTop: 4, fontWeight: 700, color: hasTenantSig ? 'var(--green)' : 'var(--text-3)' }}>
              {hasTenantSig
                ? <><CheckCircle2 size={14} style={{ verticalAlign: 'middle' }} /> Signed</>
                : 'Not yet signed'}
            </div>
          </div>
          <div style={{ padding: 12, border: '1px solid var(--border-0)', borderRadius: 8 }}>
            <div style={{ fontSize: '.72rem', color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.05em' }}>Landlord</div>
            <div style={{ marginTop: 4, fontWeight: 700, color: hasLandlordSig ? 'var(--green)' : 'var(--text-3)' }}>
              {hasLandlordSig
                ? <><CheckCircle2 size={14} style={{ verticalAlign: 'middle' }} /> Signed</>
                : 'Not yet signed'}
            </div>
            {!hasLandlordSig && insp.status !== 'finalized' && insp.status !== 'cancelled' && (
              <button
                className="btn btn-primary btn-sm"
                style={{ marginTop: 10 }}
                onClick={() => signMut.mutate()}
                disabled={signMut.isLoading}
              >
                <FileSignature size={14} /> Sign as landlord
              </button>
            )}
          </div>
        </div>
      </div>

      {/* FINALIZE */}
      {canFinalize && (
        <div className="card" style={{ padding: 16, background: 'rgba(201,162,39,.05)', borderColor: 'rgba(201,162,39,.3)' }}>
          <strong style={{ display: 'block', marginBottom: 6 }}>Ready to finalize</strong>
          <div style={{ fontSize: '.82rem', color: 'var(--text-2)', marginBottom: 12 }}>
            Both parties have signed. Finalize will:
            <ul style={{ marginLeft: 18, marginTop: 6 }}>
              <li>Lock the inspection (no further edits)</li>
              {insp.inspectionType === 'move_in' && <>
                <li>Emit <code>move_in_inspection_completed</code> + photo event to tenant credit ledger</li>
                <li>Emit <code>unit_ready_on_move_in_date</code> to landlord ledger if within 1 day of lease start</li>
              </>}
              {insp.inspectionType === 'move_out' && <>
                <li>Compare per-item conditions against the linked move-in</li>
                <li>Emit either <code>move_out_condition_matches_move_in</code> (+250) OR <code>move_out_condition_damage_documented</code> (-15%) to tenant credit ledger</li>
                <li>Emit <code>move_out_inspection_completed</code> + photo event to tenant ledger</li>
              </>}
            </ul>
          </div>
          <button
            className="btn btn-primary"
            onClick={() => finalizeMut.mutate()}
            disabled={finalizeMut.isLoading}
          >
            {finalizeMut.isLoading ? 'Finalizing…' : 'Finalize Inspection'}
          </button>
        </div>
      )}
    </div>
  )
}

function labelType(t: string) {
  return t === 'move_in' ? 'Move-in'
    : t === 'move_out' ? 'Move-out'
    : t === 'turnover' ? 'Turnover'
    : 'Periodic'
}

function RescheduleModal({
  current,
  onClose,
  onSave,
  saving,
}: {
  current: string | null
  onClose: () => void
  onSave: (v: string | null) => void
  saving: boolean
}) {
  const initial = current ? toLocalIsoMinute(new Date(current)) : ''
  const [value, setValue] = useState(initial)
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={onClose}>
      <div className="card" style={{ width: 420, maxWidth: '92vw' }} onClick={e => e.stopPropagation()}>
        <h3 style={{ marginBottom: 12 }}>Reschedule inspection</h3>
        <div style={{ fontSize: '.78rem', color: 'var(--text-3)', marginBottom: 12 }}>
          Reminder will re-arm against the new time (24h-before notification).
        </div>
        <input
          type="datetime-local"
          value={value}
          onChange={e => setValue(e.target.value)}
          className="input"
          style={{ width: '100%' }}
        />
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 16 }}>
          <button className="btn btn-ghost btn-sm" onClick={() => onSave(null)} disabled={saving}>
            Clear schedule
          </button>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button
              className="btn btn-primary"
              onClick={() => onSave(value ? new Date(value).toISOString() : null)}
              disabled={saving || !value}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function toLocalIsoMinute(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
