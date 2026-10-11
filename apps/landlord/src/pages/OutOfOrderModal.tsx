// S649 (Nic): "we need a way to mark RV sites out of order." A site marked out
// of order can't be booked for that window — the booking site, staff bookings
// and the schedule's auto-arranging all route around it, and stays already on
// it are moved to another open site where one fits (you're told if not).
//
// S652 (Nic): "the button should flip on a site that's marked out of order. If
// I click that button again, it should give me an option to mark it back in
// service instead of leaving it out of service." So this opens on whichever
// question the site is actually asking: out today → put it back; in service →
// take it out. And the outages that are over stay listed, with how long each
// one ran — putting a site back never erased the record, nothing showed it.
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { apiGet, apiPost } from '../lib/api'
import { toast } from '../components/dialogs'

const day = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
const daysBetween = (a: string, b: string) =>
  Math.round((new Date(`${b}T12:00:00`).getTime() - new Date(`${a}T12:00:00`).getTime()) / 86400000)
const span = (n: number) => n < 1 ? 'less than a day' : `${n} day${n === 1 ? '' : 's'}`

export function OutOfOrderModal({ unit, onClose }: { unit: { id: string; unitNumber: string }; onClose: () => void }) {
  const qc = useQueryClient()
  const today = new Date().toLocaleDateString('en-CA')
  const [startsOn, setStartsOn] = useState(today)
  const [endsOn, setEndsOn] = useState('')
  const [reason, setReason] = useState('')
  const [planning, setPlanning] = useState(false)
  const { data, isLoading } = useQuery<any>(['out-of-order', unit.id],
    () => apiGet(`/units/${unit.id}/out-of-order?history=1`))
  const open: any[] = data?.open ?? []
  const history: any[] = data?.history ?? []
  const outNow = open.find((w: any) => w.startsOn <= today)
  const planned = open.filter((w: any) => w.startsOn > today)

  const done = () => { qc.invalidateQueries(['out-of-order', unit.id]); qc.invalidateQueries('schedule') }
  const mark = useMutation(
    () => apiPost(`/units/${unit.id}/out-of-order`, { startsOn, endsOn: endsOn || null, reason: reason.trim() || null }),
    { onSuccess: () => { toast(`Site ${unit.unitNumber} marked out of order`); done(); setReason(''); setEndsOn(''); setPlanning(false) },
      onError: (e: any) => toast.error(e?.response?.data?.error || 'Could not mark it out of order') })
  const clear = useMutation(
    (id: string) => apiPost(`/units/${unit.id}/out-of-order/${id}/clear`, {}),
    { onSuccess: () => { toast(`Site ${unit.unitNumber} is back in service`); done() },
      onError: (e: any) => toast.error(e?.response?.data?.error || 'Could not put it back in service') })
  const badDates = !!endsOn && endsOn <= startsOn

  const form = (
    <>
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
      <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }} disabled={!startsOn || badDates || mark.isLoading} onClick={() => mark.mutate()}>
        {mark.isLoading ? 'Saving…' : 'Mark out of order'}
      </button>
    </>
  )

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 460 }} onClick={e => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>
          Site {unit.unitNumber} {outNow ? 'is out of order' : '— out of order'}
        </h3>

        {isLoading ? <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-3)' }}>Loading…</div> : outNow ? (
          <>
            <div style={{ padding: '12px 14px', borderRadius: 8, marginBottom: 14, border: '1px solid var(--border-1)',
              background: 'repeating-linear-gradient(45deg, rgba(220,60,60,.10) 0 6px, transparent 6px 14px)' }}>
              <div style={{ fontSize: '.9rem', fontWeight: 700, color: 'var(--text-0)' }}>
                Out since {day(outNow.startsOn)} — {span(daysBetween(outNow.startsOn, today))} so far
              </div>
              <div style={{ fontSize: '.78rem', color: 'var(--text-2)', marginTop: 4 }}>
                {outNow.endsOn ? `Planned back ${day(outNow.endsOn)}.` : 'No back-in-service date set.'}
                {outNow.reason ? ` ${outNow.reason}` : ''}
              </div>
            </div>
            <button className="btn btn-primary" style={{ width: '100%', marginBottom: 8, justifyContent: 'center' }} disabled={clear.isLoading}
              onClick={() => clear.mutate(outNow.id)}>
              {clear.isLoading ? 'Saving…' : 'Put back in service'}
            </button>
            <p style={{ fontSize: '.74rem', color: 'var(--text-3)', lineHeight: 1.5, margin: '0 0 12px' }}>
              The site can be booked again right away. The calendar keeps these days marked so you can see how long it was down.
            </p>
          </>
        ) : (
          <>
            <p style={{ fontSize: '.8rem', color: 'var(--text-3)', lineHeight: 1.5, marginTop: 0 }}>
              Nothing can be booked here while it&apos;s out of order. Stays already on it move to another
              open site that fits; if none does, you&apos;ll get a notice to sort it out.
            </p>
            {form}
          </>
        )}

        {planned.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: '.68rem', color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.05em' }}>Planned</div>
            {planned.map((w: any) => (
              <div key={w.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: '1px solid var(--border-0)' }}>
                <div style={{ flex: 1, fontSize: '.82rem' }}>
                  Out from {day(w.startsOn)}{w.endsOn ? ` until ${day(w.endsOn)}` : ' until put back in service'}
                  {w.reason && <div style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>{w.reason}</div>}
                </div>
                <button className="btn btn-primary btn-sm" disabled={clear.isLoading} onClick={() => clear.mutate(w.id)}>Call it off</button>
              </div>
            ))}
          </div>
        )}

        {outNow && (planning
          ? <div style={{ marginTop: 14 }}>{form}</div>
          : <button className="btn btn-primary btn-sm" style={{ marginTop: 4 }} onClick={() => { setPlanning(true); setStartsOn(today) }}>Plan another outage</button>)}

        {history.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <div style={{ fontSize: '.68rem', color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 2 }}>
              Past outages
            </div>
            <div style={{ maxHeight: 180, overflowY: 'auto' }}>
              {history.map((h: any) => (
                <div key={h.id} style={{ display: 'flex', gap: 8, padding: '7px 0', borderBottom: '1px solid var(--border-0)', fontSize: '.8rem' }}>
                  <div style={{ flex: 1 }}>
                    {day(h.startsOn)} – {day(h.endedOn)}
                    {h.reason && <div style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>{h.reason}</div>}
                  </div>
                  <div className="mono" style={{ color: 'var(--text-2)', whiteSpace: 'nowrap' }}>{span(Number(h.daysOut))}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}
