import { useState, useRef, Fragment } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { useParams, useNavigate } from 'react-router-dom'
import {
  ClipboardCheck, ArrowLeft, Plus, Camera, Video, Film,
  CheckCircle2, FileSignature, Calendar, AlertTriangle, FileText,
} from 'lucide-react'
import { api, apiGet, apiPatch, apiPost } from '../lib/api'
import { INSPECTION_ITEM_CONDITIONS, INSPECTION_ITEM_CONDITION_LABEL } from '@gam/shared'
import { inspectionStatusLabel } from './InspectionsPage'
import { CameraCapture } from '../components/CameraCapture'
import { AuthedImg, AuthedVideo } from '../components/AuthedMedia'

type Item = {
  id: string
  area: string
  itemLabel: string
  condition: 'excellent' | 'good' | 'fair' | 'damaged_missing' | null
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
  flaggedSuspiciousAt: string | null
  flagReason: string | null
  followupInspectionId: string | null
  reportUrl: string | null
  unitNumber: string | null
  unitType: string | null
  propertyName: string | null
  tenantFirstName: string | null
  tenantLastName: string | null
  items: Item[]
  photos: Photo[]
  signatures: Sig[]
}

const COND_BADGE: Record<string, string> = {
  excellent:       'badge-green',
  good:            'badge-green',
  fair:            'badge-amber',
  damaged_missing: 'badge-red',
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
  const [showFlag, setShowFlag] = useState(false)
  const [camera, setCamera] = useState<null | 'photo' | 'video'>(null)

  const { data, isLoading } = useQuery<Detail>(
    ['inspection', id],
    () => apiGet<Detail>(`/inspections/${id}`),
  )

  // S573: what still blocks submit/sign/finalize (items missing a condition,
  // areas missing a photo, fair/damaged items missing a note).
  type Completeness = { complete: boolean; itemsMissingCondition: number; itemsMissingNote: number; areasMissingPhoto: string[]; totalAreas: number }
  const { data: completeness } = useQuery<Completeness>(
    ['inspection-completeness', id],
    () => apiGet<Completeness>(`/inspections/${id}/completeness`),
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

  // S573: inline per-item edits during conduct (upsert by area+item_label —
  // same endpoint as add-item). Lets staff/agent walk the checklist item by
  // item without re-typing each area+item into a form.
  const saveItemMut = useMutation(
    (body: any) => apiPost(`/inspections/${id}/items`, body),
    {
      onSuccess: () => { qc.invalidateQueries(['inspection', id]); qc.invalidateQueries(['inspection-completeness', id]) },
      onError: (e: any) => setError(e?.response?.data?.error || 'Failed to save item'),
    },
  )
  const commitItem = (it: Item, patch: { condition?: string; notes?: string }) => {
    // A condition is required to save (the note rides it). Editing a note before
    // a condition is set is a no-op — pick the condition first.
    const condition = patch.condition ?? it.condition
    if (!condition) return
    saveItemMut.mutate({
      area: it.area,
      itemLabel: it.itemLabel,
      condition,
      notes: patch.notes !== undefined ? patch.notes : (it.notes ?? ''),
    })
  }

  // S573: capture a photo linked to a checklist ITEM (so it counts toward that
  // AREA's required coverage). captureItemId tracks which area we're shooting.
  const [captureItemId, setCaptureItemId] = useState<string | null>(null)
  const photoMut = useMutation(
    ({ file, live, itemId }: { file: File; live?: boolean; itemId?: string | null }) => {
      const fd = new FormData()
      fd.append('file', file)
      if (live) fd.append('capturedLive', 'true')
      if (itemId) fd.append('itemId', itemId)
      return api.post(`/inspections/${id}/photos`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      }).then(r => r.data)
    },
    {
      onSuccess: () => { setCaptureItemId(null); qc.invalidateQueries(['inspection', id]); qc.invalidateQueries(['inspection-completeness', id]) },
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

  // S573: fetch the summary-report PDF with auth (the file route needs the
  // Bearer token, so open it via the api instance as a blob, not a bare <a>).
  const [downloadingReport, setDownloadingReport] = useState(false)
  const downloadReport = async (reportUrl: string) => {
    setDownloadingReport(true)
    try {
      const res = await api.get(reportUrl.replace(/^\/api/, ''), { responseType: 'blob' })
      const url = URL.createObjectURL(res.data as Blob)
      window.open(url, '_blank')
      setTimeout(() => URL.revokeObjectURL(url), 60000)
    } catch {
      setError('Could not open the report')
    } finally {
      setDownloadingReport(false)
    }
  }

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

  const flagMut = useMutation(
    (reason: string) => apiPost(`/inspections/${id}/flag-suspicious`, { reason }),
    {
      onSuccess: () => {
        qc.invalidateQueries(['inspection', id])
        qc.invalidateQueries('inspections')
        setShowFlag(false)
      },
      onError: (e: any) => setError(e?.response?.data?.error || 'Flag failed'),
    },
  )

  if (isLoading || !data) return <div style={{ padding: 32, color: 'var(--text-3)' }}>Loading…</div>

  const insp = data as Detail
  const editable = insp.status === 'draft'
  const hasTenantSig = insp.signatures.some(s => s.signerRole === 'tenant')
  const hasLandlordSig = insp.signatures.some(s => s.signerRole === 'landlord' || s.signerRole === 'inspector')
  const canFinalize = insp.status === 'landlord_signed'
  // Tenant signature only gates move-in (their certification of photos +
  // conditions). Periodic/move-out are staff-conducted under entry notice.
  const tenantSigRequired = insp.inspectionType === 'move_in' && !!insp.tenantId

  // S573: group the checklist by area + which areas already have a photo (a
  // photo counts for its item's area). Drives the per-area capture + coverage.
  const itemAreaById = new Map(insp.items.map(i => [i.id, i.area]))
  const photographedAreas = new Set<string>()
  for (const p of insp.photos) if (p.itemId && itemAreaById.has(p.itemId)) photographedAreas.add(itemAreaById.get(p.itemId)!)
  const areaOrder: string[] = []
  const areaItems = new Map<string, Item[]>()
  for (const it of insp.items) {
    if (!areaItems.has(it.area)) { areaItems.set(it.area, []); areaOrder.push(it.area) }
    areaItems.get(it.area)!.push(it)
  }

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
            {insp.flaggedSuspiciousAt
              ? <span className="badge badge-red" style={{ marginLeft: 6 }}>Flagged suspicious</span>
              : <span className={`badge ${STATUS_BADGE[insp.status] || 'badge-muted'}`} style={{ marginLeft: 6 }}>
                  {inspectionStatusLabel(insp.inspectionType, insp.status)}
                </span>}
          </h1>
          <div className="page-sub">
            Unit {insp.unitNumber ?? insp.unitId.slice(0, 8)}
            {insp.propertyName && <> · {insp.propertyName}</>}
            {(insp.tenantFirstName || insp.tenantLastName) && <> · {[insp.tenantFirstName, insp.tenantLastName].filter(Boolean).join(' ')}</>}
            {insp.comparisonInspectionId && <> · compared to the linked move-in</>}
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
          onClose={() => { setCamera(null); setCaptureItemId(null) }}
          onCapture={(file) => (camera === 'photo' ? photoMut : videoMut).mutate({ file, live: true, itemId: captureItemId })}
        />
      )}

      {error && (
        <div className="card" style={{ padding: 12, marginBottom: 16, background: 'rgba(239,68,68,.08)', borderColor: 'rgba(239,68,68,.3)', color: 'var(--red)' }}>
          {error}
        </div>
      )}

      {insp.flaggedSuspiciousAt && (
        <div className="card" style={{ padding: 16, marginBottom: 16, background: 'rgba(239,68,68,.06)', borderColor: 'rgba(239,68,68,.3)' }}>
          <div style={{ fontWeight: 700, color: 'var(--red)', marginBottom: 6 }}>
            <AlertTriangle size={15} style={{ verticalAlign: 'middle', marginRight: 6 }} />
            Flagged suspicious on {new Date(insp.flaggedSuspiciousAt).toLocaleDateString()}
          </div>
          <div style={{ fontSize: '.82rem', color: 'var(--text-2)', marginBottom: insp.followupInspectionId ? 10 : 0 }}>
            {insp.flagReason ? <>Reason: {insp.flagReason}. </> : null}
            This tenant-submitted inspection is closed; an in-person inspection was scheduled in its place.
            The tenant was notified of the visit date only — the flag reason stays internal.
          </div>
          {insp.followupInspectionId && (
            <button className="btn btn-primary btn-sm" onClick={() => navigate(`/inspections/${insp.followupInspectionId}`)}>
              Open in-person inspection →
            </button>
          )}
        </div>
      )}

      {/* Verdict card — tenant-self-directed periodic review (S549) */}
      {insp.inspectionType === 'periodic' && insp.tenantId && !insp.flaggedSuspiciousAt
        && insp.status !== 'finalized' && insp.status !== 'cancelled' && (
        <div className="card" style={{ padding: 16, marginBottom: 16 }}>
          <strong style={{ display: 'block', marginBottom: 6 }}>Review tenant submission</strong>
          <div style={{ fontSize: '.82rem', color: 'var(--text-2)', marginBottom: 12 }}>
            Check the photos below against the checklist. If everything looks right, sign and
            finalize to pass it. If anything looks staged, reused, or wrong, flag it — an
            in-person inspection is scheduled automatically and staff are notified.
          </div>
          <button className="btn btn-danger btn-sm" onClick={() => setShowFlag(true)}>
            <AlertTriangle size={14} /> Flag as suspicious
          </button>
        </div>
      )}

      {showFlag && (
        <FlagModal
          onClose={() => setShowFlag(false)}
          onSubmit={(reason) => flagMut.mutate(reason)}
          saving={flagMut.isLoading}
        />
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

      {/* S573: summary report — generated at finalize, filed to the tenant's
          Documents and available here for the landlord's records. */}
      {insp.status === 'finalized' && insp.reportUrl && (
        <div className="card" style={{ padding: 16, marginBottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <FileText size={18} style={{ color: 'var(--gold)' }} />
            <div>
              <div style={{ fontWeight: 700, fontSize: '.9rem' }}>Inspection summary report</div>
              <div style={{ fontSize: '.75rem', color: 'var(--text-3)' }}>Filed to the tenant's Documents. Includes conditions{insp.inspectionType === 'move_out' ? ', repair costs & the move-in comparison' : ' & photos'}.</div>
            </div>
          </div>
          <button className="btn btn-primary btn-sm" onClick={() => downloadReport(insp.reportUrl!)} disabled={downloadingReport}>
            {downloadingReport ? 'Opening…' : 'Download PDF'}
          </button>
        </div>
      )}

      {/* CHECKLIST */}
      <div className="card" style={{ padding: 0, marginBottom: 16 }}>
        <div style={{ padding: 16, borderBottom: '1px solid var(--border-0)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <strong>Checklist ({insp.items.length})</strong>
          {!editable && <span className="badge badge-muted">read-only</span>}
        </div>
        {editable && completeness && !completeness.complete && (
          <div style={{ padding: '10px 16px', background: 'rgba(245,158,11,.08)', borderBottom: '1px solid var(--border-0)', fontSize: '.8rem', color: 'var(--text-2)' }}>
            <strong style={{ color: 'var(--amber)' }}>To finish:</strong>{' '}
            {[
              completeness.itemsMissingCondition ? `${completeness.itemsMissingCondition} item(s) need a condition` : null,
              completeness.areasMissingPhoto.length ? `${completeness.areasMissingPhoto.length} area(s) need a photo` : null,
              completeness.itemsMissingNote ? `${completeness.itemsMissingNote} fair/damaged item(s) need a note` : null,
            ].filter(Boolean).join('  ·  ')}
          </div>
        )}
        {editable && completeness && completeness.complete && (
          <div style={{ padding: '8px 16px', background: 'rgba(34,197,94,.08)', borderBottom: '1px solid var(--border-0)', fontSize: '.78rem', color: 'var(--green)' }}>
            ✓ Complete — every area photographed, every item rated.
          </div>
        )}
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
              </tr>
            </thead>
            <tbody>
              {areaOrder.map(area => (
                <Fragment key={area}>
                  <tr style={{ background: 'var(--bg-1)' }}>
                    <td colSpan={4} style={{ padding: '8px 12px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                        <strong style={{ fontSize: '.82rem' }}>{area}</strong>
                        {photographedAreas.has(area)
                          ? <span className="badge badge-green" style={{ fontSize: '.62rem' }}>✓ photo</span>
                          : <span className="badge badge-amber" style={{ fontSize: '.62rem' }}>photo required</span>}
                        {editable && (
                          <button className="btn btn-ghost btn-sm" style={{ padding: '1px 8px' }}
                            onClick={() => { setCaptureItemId(areaItems.get(area)![0].id); setCamera('photo') }}>
                            <Camera size={12} /> {photographedAreas.has(area) ? 'Add photo' : 'Take photo'}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                  {areaItems.get(area)!.map(it => (
                    <tr key={it.id}>
                      <td />
                      <td><strong>{it.itemLabel}</strong></td>
                      {editable ? (
                        <>
                          <td>
                            <select className="input" style={{ padding: '3px 6px', fontSize: '.8rem', minWidth: 130 }}
                              value={it.condition ?? ''}
                              onChange={e => commitItem(it, { condition: e.target.value })}>
                              <option value="" disabled>— set condition —</option>
                              {INSPECTION_ITEM_CONDITIONS.map(c => (
                                <option key={c} value={c}>{INSPECTION_ITEM_CONDITION_LABEL[c]}</option>
                              ))}
                            </select>
                          </td>
                          <td>
                            <input className="input" style={{ padding: '3px 6px', fontSize: '.8rem', width: '100%' }}
                              defaultValue={it.notes ?? ''} placeholder={it.condition && it.condition !== 'excellent' && it.condition !== 'good' ? 'Note (required — what’s wrong)' : 'Note (optional)'}
                              onBlur={e => { if (e.target.value !== (it.notes ?? '')) commitItem(it, { notes: e.target.value }) }} />
                          </td>
                        </>
                      ) : (
                        <>
                          <td>{it.condition
                            ? <span className={`badge ${COND_BADGE[it.condition]}`}>{INSPECTION_ITEM_CONDITION_LABEL[it.condition]}</span>
                            : <span className="badge badge-muted">Not inspected</span>}</td>
                          <td style={{ fontSize: '.8rem', color: 'var(--text-2)' }}>{it.notes || '—'}</td>
                        </>
                      )}
                    </tr>
                  ))}
                </Fragment>
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
                value={newItem.condition ?? 'good'}
                onChange={e => setNewItem({ ...newItem, condition: e.target.value as Item['condition'] })}
                className="input"
              >
                {INSPECTION_ITEM_CONDITIONS.map(c => (
                  <option key={c} value={c}>{INSPECTION_ITEM_CONDITION_LABEL[c]}</option>
                ))}
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
                : tenantSigRequired ? 'Not yet signed' : 'Not required'}
            </div>
            {!tenantSigRequired && !hasTenantSig && (
              <div style={{ marginTop: 4, fontSize: '.72rem', color: 'var(--text-3)' }}>
                Tenant signature only gates move-in inspections — this one finalizes on the landlord signature.
              </div>
            )}
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
            {tenantSigRequired ? 'Both parties have signed.' : 'Signatures complete.'} Finalize will:
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

function FlagModal({
  onClose,
  onSubmit,
  saving,
}: {
  onClose: () => void
  onSubmit: (reason: string) => void
  saving: boolean
}) {
  const [reason, setReason] = useState('')
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={onClose}>
      <div className="card" style={{ width: 460, maxWidth: '92vw' }} onClick={e => e.stopPropagation()}>
        <h3 style={{ marginBottom: 8 }}>Flag as suspicious</h3>
        <div style={{ fontSize: '.8rem', color: 'var(--text-2)', marginBottom: 12 }}>
          This closes the tenant-submitted inspection and schedules an in-person inspection
          three business days out. The landlord and property staff see your reason; the tenant
          is only told the visit date.
        </div>
        <textarea
          className="input"
          rows={3}
          placeholder="What looks wrong? (e.g. photos reused from move-in, damage cropped out)"
          value={reason}
          onChange={e => setReason(e.target.value)}
          style={{ width: '100%', resize: 'vertical' }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button className="btn btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button
            className="btn btn-danger"
            onClick={() => onSubmit(reason.trim())}
            disabled={saving || reason.trim().length < 3}
          >
            {saving ? 'Flagging…' : 'Flag & schedule in-person'}
          </button>
        </div>
      </div>
    </div>
  )
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
        <h3 style={{ marginBottom: 12 }}>Reschedule Inspection</h3>
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
