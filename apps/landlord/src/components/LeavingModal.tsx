/**
 * S653 (Nic): "THEY'RE LEAVING ON…" — the front desk writes down the day.
 *
 *   "They're going to come in and say, hey, I'm pulling out Saturday with like
 *    maybe three or four days notice, if that. We need the front desk to be able
 *    to mark it as, hey, they're leaving then. When we get the final meter read,
 *    we can initiate the final bill cycle."
 *
 * One modal, used from the Front Desk (Move-outs tab) and from a lease's Change
 * menu. It records what the resident said and nothing else — no notice period,
 * nothing on any signed document. The day is the departure day: the space is
 * theirs through the night before, open to a new arrival from that morning.
 *
 * "Saturday" is a tap, not a calendar hunt: the next seven days sit as chips
 * above the date box, because that is how the sentence arrives at the counter.
 */
import { useState } from 'react'
import { useMutation, useQueryClient } from 'react-query'
import { apiPost, apiDelete } from '../lib/api'
import { X, CalendarX } from 'lucide-react'

export interface LeavingLease {
  leaseId: string
  unitNumber: string
  propertyName?: string | null
  names: string
  startDate?: string | null
  endDate: string | null
  moveOutNoticeAt: string | null
  moveOutNoticeNote?: string | null
  moveOutNoticePrevEndDate?: string | null
  markedBy?: string | null
}

const iso = (d: Date) => {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
const sayDay = (s: string) => {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
}
const errText = (e: any) => e?.response?.data?.error || e?.message || 'Something went wrong'

export function LeavingModal({ lease, onClose, onSaved }: {
  lease: LeavingLease
  onClose: () => void
  onSaved?: () => void
}) {
  const qc = useQueryClient()
  const today = iso(new Date())
  const hasNotice = !!lease.moveOutNoticeAt
  const [changing, setChanging] = useState(!hasNotice)
  const [on, setOn] = useState<string>(hasNotice ? (lease.endDate ?? '') : '')
  const [note, setNote] = useState(lease.moveOutNoticeNote ?? '')
  const [error, setError] = useState<string | null>(null)

  const refresh = () => {
    qc.invalidateQueries('leases')
    qc.invalidateQueries('desk-residents')
    onSaved?.()
  }
  const mark = useMutation(
    () => apiPost(`/leases/${lease.leaseId}/leaving`, { on, note: note.trim() || null }),
    { onSuccess: () => { refresh(); onClose() }, onError: (e: any) => setError(errText(e)) })
  const callOff = useMutation(
    () => apiDelete(`/leases/${lease.leaseId}/leaving`),
    { onSuccess: () => { refresh(); onClose() }, onError: (e: any) => setError(errText(e)) })

  // The next seven days as chips — "Saturday" is one tap.
  const chips = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(); d.setDate(d.getDate() + i)
    const v = iso(d)
    const label = i === 0 ? 'Today' : i === 1 ? 'Tomorrow'
      : d.toLocaleDateString(undefined, { weekday: 'long' })
    return { v, label }
  })

  // The signed end, if any — a notice can only bring it forward.
  const signedEnd = hasNotice ? (lease.moveOutNoticePrevEndDate ?? null) : lease.endDate
  const busy = mark.isLoading || callOff.isLoading

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 470 }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title" style={{ marginBottom: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <CalendarX size={16} /> {hasNotice && !changing ? 'Leaving date on file' : 'They\'re leaving on…'}
          </span>
          <button className="btn btn-ghost btn-sm" onClick={onClose}><X size={14} /></button>
        </div>

        <div style={{ fontSize: '.84rem', color: 'var(--text-1)', marginBottom: 12 }}>
          <strong>{lease.names || 'This household'}</strong> · {lease.unitNumber}
          {lease.propertyName ? <span style={{ color: 'var(--text-3)' }}> · {lease.propertyName}</span> : null}
        </div>

        {hasNotice && !changing ? (
          <>
            <div style={{ padding: '12px 14px', borderRadius: 10, background: 'var(--bg-2)', border: '1px solid var(--border-1)', marginBottom: 12 }}>
              <div style={{ fontSize: '1.05rem', fontWeight: 800, color: 'var(--gold)' }}>{lease.endDate ? sayDay(lease.endDate) : '—'}</div>
              {lease.moveOutNoticeNote && (
                <div style={{ fontSize: '.8rem', color: 'var(--text-2)', marginTop: 4 }}>“{lease.moveOutNoticeNote}”</div>
              )}
              <div style={{ fontSize: '.74rem', color: 'var(--text-3)', marginTop: 6 }}>
                {lease.markedBy ? `Written down by ${lease.markedBy}` : 'On file'}
                {lease.moveOutNoticeAt ? ` on ${new Date(lease.moveOutNoticeAt).toLocaleDateString()}` : ''}.
                {signedEnd ? ` Their lease had run to ${sayDay(signedEnd)}.` : ' They were month to month.'}
              </div>
            </div>
            <div style={{ fontSize: '.78rem', color: 'var(--text-2)', lineHeight: 1.5, marginBottom: 12 }}>
              Their meters are read that morning; the final utility charge goes out right after and the deposit return follows.
              The space is open to a new arrival from that day.
            </div>
            {error && <div style={{ marginBottom: 10, padding: '8px 10px', borderRadius: 8, background: 'rgba(239,68,68,.08)', border: '1px solid rgba(239,68,68,.3)', color: 'var(--red)', fontSize: '.78rem' }}>{error}</div>}
            <div className="modal-footer" style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-ghost" onClick={() => callOff.mutate()} disabled={busy}
                title="They changed their mind — the lease goes back to what it was">
                {callOff.isLoading ? 'Calling off…' : 'They\'re staying — call it off'}
              </button>
              <button className="btn btn-primary" style={{ marginLeft: 'auto' }} onClick={() => setChanging(true)} disabled={busy}>
                Change the day
              </button>
            </div>
          </>
        ) : (
          <>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
              {chips.map(c => (
                <button key={c.v} type="button" onClick={() => setOn(c.v)}
                  className={`btn btn-sm ${on === c.v ? 'btn-primary' : 'btn-ghost'}`}
                  disabled={!!signedEnd && c.v > signedEnd}>
                  {c.label}
                </button>
              ))}
            </div>
            <label style={{ display: 'block', fontSize: '.76rem', color: 'var(--text-3)', marginBottom: 10 }}>
              Or another day
              <input type="date" className="input" value={on} min={today} max={signedEnd ?? undefined}
                onChange={e => setOn(e.target.value)} style={{ display: 'block', marginTop: 4 }} />
            </label>
            {on && (
              <div style={{ fontSize: '.84rem', color: 'var(--text-1)', marginBottom: 10 }}>
                Leaving <strong>{sayDay(on)}</strong> — theirs through the night before, open from that morning.
              </div>
            )}
            <label style={{ display: 'block', fontSize: '.76rem', color: 'var(--text-3)', marginBottom: 12 }}>
              What they said (optional)
              <input className="input" value={note} maxLength={500} placeholder="e.g. heading north, will settle up Friday"
                onChange={e => setNote(e.target.value)} style={{ display: 'block', marginTop: 4, width: '100%' }} />
            </label>
            {signedEnd && (
              <div style={{ fontSize: '.74rem', color: 'var(--text-3)', marginBottom: 10 }}>
                Their lease runs to {sayDay(signedEnd)}. To stay past that, invite them to a new lease from the Tenants page.
              </div>
            )}
            {error && <div style={{ marginBottom: 10, padding: '8px 10px', borderRadius: 8, background: 'rgba(239,68,68,.08)', border: '1px solid rgba(239,68,68,.3)', color: 'var(--red)', fontSize: '.78rem' }}>{error}</div>}
            <div className="modal-footer" style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-ghost" onClick={hasNotice ? () => setChanging(false) : onClose} disabled={busy}>
                {hasNotice ? 'Back' : 'Cancel'}
              </button>
              <button className="btn btn-primary" style={{ marginLeft: 'auto' }} disabled={!on || busy} onClick={() => mark.mutate()}>
                {mark.isLoading ? 'Saving…' : 'Mark as leaving'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
