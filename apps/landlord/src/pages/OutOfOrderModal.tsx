// S649 (Nic): "we need a way to mark RV sites out of order." A site marked out
// of order can't be booked for that window — the booking site, staff bookings
// and the schedule's auto-arranging all route around it, and stays already on
// it are moved to another open site where one fits (you're told if not).
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { apiGet, apiPost } from '../lib/api'
import { toast } from '../components/dialogs'

export function OutOfOrderModal({ unit, onClose }: { unit: { id: string; unitNumber: string }; onClose: () => void }) {
  const qc = useQueryClient()
  const today = new Date().toISOString().slice(0, 10)
  const [startsOn, setStartsOn] = useState(today)
  const [endsOn, setEndsOn] = useState('')
  const [reason, setReason] = useState('')
  const { data: windows = [] } = useQuery<any[]>(['out-of-order', unit.id], () => apiGet(`/units/${unit.id}/out-of-order`))
  const done = () => { qc.invalidateQueries(['out-of-order', unit.id]); qc.invalidateQueries('schedule') }
  const mark = useMutation(
    () => apiPost(`/units/${unit.id}/out-of-order`, { startsOn, endsOn: endsOn || null, reason: reason.trim() || null }),
    { onSuccess: () => { toast(`Site ${unit.unitNumber} marked out of order`); done(); setReason(''); setEndsOn('') },
      onError: (e: any) => toast.error(e?.response?.data?.error || 'Could not mark it out of order') })
  const clear = useMutation(
    (id: string) => apiPost(`/units/${unit.id}/out-of-order/${id}/clear`, {}),
    { onSuccess: () => { toast(`Site ${unit.unitNumber} is back in service`); done() },
      onError: (e: any) => toast.error(e?.response?.data?.error || 'Could not put it back in service') })
  const badDates = !!endsOn && endsOn <= startsOn
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 440 }} onClick={e => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>Site {unit.unitNumber} — out of order</h3>
        <p style={{ fontSize: '.8rem', color: 'var(--text-3)', lineHeight: 1.5, marginTop: 0 }}>
          Nothing can be booked here while it&apos;s out of order. Stays already on it move to another
          open site that fits; if none does, you&apos;ll get a notice to sort it out.
        </p>
        {windows.length > 0 && (
          <div style={{ marginBottom: 14 }}>
            {windows.map((w: any) => (
              <div key={w.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: '1px solid var(--border-0)' }}>
                <div style={{ flex: 1, fontSize: '.82rem' }}>
                  Out from {w.startsOn}{w.endsOn ? ` until ${w.endsOn}` : ' until put back in service'}
                  {w.reason && <div style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>{w.reason}</div>}
                </div>
                <button className="btn btn-primary btn-sm" disabled={clear.isLoading} onClick={() => clear.mutate(w.id)}>Back in service</button>
              </div>
            ))}
          </div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
          <label style={{ fontSize: '.75rem', color: 'var(--text-3)' }}>Out from
            <input className="form-input" type="date" value={startsOn} onChange={e => setStartsOn(e.target.value)} style={{ width: '100%', marginTop: 4 }} />
          </label>
          <label style={{ fontSize: '.75rem', color: 'var(--text-3)' }}>Back on (optional)
            <input className="form-input" type="date" value={endsOn} onChange={e => setEndsOn(e.target.value)} style={{ width: '100%', marginTop: 4 }} />
          </label>
        </div>
        <input className="form-input" placeholder="What's wrong (optional) — e.g. broken pedestal" value={reason}
          onChange={e => setReason(e.target.value)} style={{ width: '100%', marginBottom: 10 }} />
        {badDates && <div className="alert alert-warning" style={{ fontSize: '.8rem', marginBottom: 10 }}>The back-in-service day has to be after the start.</div>}
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-primary" style={{ flex: 1 }} disabled={!startsOn || badDates || mark.isLoading} onClick={() => mark.mutate()}>
            {mark.isLoading ? 'Saving…' : 'Mark out of order'}
          </button>
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}
