/**
 * 10/19 (Nic): CLOSE THE DEPARTING RESIDENT OUT on a tenant-owned home.
 *
 *   "I want to go through and mark Rashawn as moved out in the system when it's
 *    time to do that. And then add Jacob to the space or invite him to the
 *    space. And I want to see how that carry forward balance flow goes."
 *
 * Today nothing in the product closes him out: his lease on MH 09 is active
 * with no end date, the space still reads as taken, and the $880 of unpaid
 * space rent is still addressed to a man who has gone.
 *
 * This is the screen he decides from, and it shows FOUR FIGURES before it will
 * write anything — because three different things happen to one resident's
 * money at once and a landlord pressing a button called "close out" has a right
 * to know which is which:
 *
 *   · what becomes the SPACE's balance        the unpaid space rent, $880
 *   · what stays HIS OWN debt                 utilities, fees, a deposit, $1,051
 *   · what is dropped outright                the late fees, $95
 *   · and that his lease closes                so the space stops counting as occupied
 *
 * Nothing is written by opening this. The figures come from the service's own
 * preview (previewSpaceRentCarryforward), which reads and returns; the write
 * happens on the press, in one transaction, and only after the figure the
 * landlord saw is sent back and matched against the live one.
 *
 * ON A SPACE WHERE THIS DOES NOT APPLY the action is NOT hidden — it says why,
 * in the service's own words. An RV spot is the case that matters: the guest
 * owns the RV, so a landlord may reasonably expect this to work there, and 94
 * live RV spots are marked tenant-owned. Nic: "that should never happen to an
 * RV because somebody leaves with their RV and somebody else comes in with
 * their own RV."
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from 'react-query'
import { apiGet, apiPost } from '../lib/api'
import { X, LogOut, Check, AlertTriangle } from 'lucide-react'

const fmt = (n: any) => `$${Number(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const iso = (d: Date) => {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
const sayDay = (s: string | null | undefined) => {
  if (!s) return '—'
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })
}
const errText = (e: any) => e?.response?.data?.error || e?.message || 'Something went wrong'

export interface CarryforwardLine {
  id: string; type: string; amount: number; dueDate: string; label: string; detail: string | null
}
export interface CloseOutPreview {
  leaseId: string; unitId: string; spaceName: string; propertyName: string
  departingTenantName: string | null
  dwellingOwnership: string | null
  recordedHomeOwnerName: string | null
  eligible: boolean; reason: string | null
  carries: CarryforwardLine[]; carriesTotal: number
  stays: CarryforwardLine[]; staysTotal: number
  waives: CarryforwardLine[]; waivesTotal: number
  oldestDueDate: string | null
  existingCarryforwardId: string | null
}

export interface CloseOutLease {
  id: string
  unitNumber: string
  propertyName?: string | null
  names?: string | null
}

/** One figure, with the rows behind it so a landlord can check it. */
function Figure({ title, total, tone, what, lines }: {
  title: string; total: number; tone: string; what: string; lines: CarryforwardLine[]
}) {
  return (
    <div style={{ padding: '12px 14px', borderRadius: 10, background: 'var(--bg-2)', border: '1px solid var(--border-0)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
        <div style={{ fontSize: '.78rem', fontWeight: 700, color: 'var(--text-1)' }}>{title}</div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: '1.05rem', fontWeight: 800, color: tone }}>{fmt(total)}</div>
      </div>
      <div style={{ fontSize: '.74rem', color: 'var(--text-3)', lineHeight: 1.5, marginTop: 4 }}>{what}</div>
      {lines.length > 0 && (
        <div style={{ marginTop: 8, borderTop: '1px solid var(--border-0)', paddingTop: 6 }}>
          {lines.map(l => (
            <div key={l.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: '.74rem', color: 'var(--text-2)', padding: '2px 0' }}>
              <span>{l.label}<span style={{ color: 'var(--text-3)' }}> · due {sayDay(l.dueDate)}</span></span>
              <span className="mono">{fmt(l.amount)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function CloseOutSpaceModal({ lease, onClose, onClosedOut }: {
  lease: CloseOutLease
  onClose: () => void
  /** Called with the new claim's id so the caller can open the balance it created. */
  onClosedOut?: (carryforwardId: string) => void
}) {
  const qc = useQueryClient()
  const today = iso(new Date())
  const [endDate, setEndDate] = useState<string>('')
  const [notes, setNotes] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [moved, setMoved] = useState(false)
  const [done, setDone] = useState<null | {
    carryforwardId: string; carriedAmount: number; lateFeesWaived: number
    stayedWithDepartingTenant: number; leaseEndedOn: string
  }>(null)

  const preview = useQuery<CloseOutPreview>(
    ['space-carryforward-preview', lease.id],
    () => apiGet<CloseOutPreview>(`/leases/${lease.id}/space-carryforward/preview`),
    // No onSuccess reset here: the re-read that FOLLOWS a moved figure is the
    // very thing that fetches the new one, so clearing the flag on it wiped the
    // "asked again" banner the instant it was earned. Only a new press clears it.
    { retry: false, refetchOnWindowFocus: true },
  )
  const pv = preview.data

  const closeOut = useMutation(
    async () => {
      setMoved(false)
      setError(null)
      const res: any = await apiPost(`/leases/${lease.id}/space-carryforward/close-out`, {
        endDate: endDate || undefined,
        notes: notes.trim() || undefined,
        // The desk rule (S655): the figure the landlord agreed to is the figure
        // sent. If a payment landed between opening this and pressing, the
        // server refuses and the screen asks again with the new one, in place.
        expectedCarried: pv?.carriesTotal,
      })
      return res?.data ?? res
    },
    {
      onSuccess: (d: any) => {
        setError(null)
        setDone(d)
        qc.invalidateQueries('leases')
        qc.invalidateQueries('units')
        qc.invalidateQueries('vacant-units')
        qc.invalidateQueries('desk-residents')
        qc.invalidateQueries('space-carryforwards')
      },
      onError: (e: any) => {
        const msg = errText(e)
        setError(msg)
        // A moved figure is asked again rather than retried silently.
        if (e?.response?.status === 409 && /has changed|no unpaid space rent/i.test(msg)) {
          setMoved(true)
          preview.refetch()
        }
      },
    },
  )

  const who = pv?.departingTenantName || lease.names || 'This resident'
  const space = pv?.spaceName || lease.unitNumber
  const park = pv?.propertyName || lease.propertyName || ''

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 560 }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title" style={{ marginBottom: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <LogOut size={16} /> {done ? 'Closed out' : 'They left — close them out'}
          </span>
          <button className="btn btn-ghost btn-sm" onClick={onClose}><X size={14} /></button>
        </div>

        <div style={{ fontSize: '.84rem', color: 'var(--text-1)', marginBottom: 12 }}>
          <strong>{who}</strong> · {space}
          {park ? <span style={{ color: 'var(--text-3)' }}> · {park}</span> : null}
        </div>

        {preview.isLoading && <div style={{ fontSize: '.82rem', color: 'var(--text-3)' }}>Working out what the space carries…</div>}

        {preview.isError && (
          <div style={{ padding: '10px 12px', borderRadius: 8, background: 'rgba(239,68,68,.08)', border: '1px solid rgba(239,68,68,.3)', color: 'var(--red)', fontSize: '.8rem' }}>
            {errText(preview.error)}
          </div>
        )}

        {/* ── Done ─────────────────────────────────────────────────────────── */}
        {done && (
          <>
            <div style={{ padding: '12px 14px', borderRadius: 10, background: 'rgba(30,219,122,.08)', border: '1px solid rgba(30,219,122,.3)', marginBottom: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '.85rem', fontWeight: 700, color: 'var(--text-0)' }}>
                <Check size={15} style={{ color: 'var(--green)' }} /> {space} now carries {fmt(done.carriedAmount)}
              </div>
              <div style={{ fontSize: '.78rem', color: 'var(--text-2)', lineHeight: 1.6, marginTop: 6 }}>
                {fmt(done.stayedWithDepartingTenant)} stays {who}&apos;s own debt. {fmt(done.lateFeesWaived)} of late
                fees are dropped. Their lease ended {sayDay(done.leaseEndedOn)} and the space is open.
                <br />
                {who} still owes the {fmt(done.carriedAmount)} until it is paid — whoever pays it, it is the same
                one balance, so it can never be collected twice.
              </div>
            </div>
            <div className="modal-footer" style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-ghost" onClick={onClose}>Close</button>
              <button className="btn btn-primary" style={{ marginLeft: 'auto' }}
                onClick={() => { onClosedOut?.(done.carryforwardId) }}>
                See what the space carries
              </button>
            </div>
          </>
        )}

        {/* ── This space does not work this way ────────────────────────────── */}
        {!done && pv && !pv.eligible && (
          <>
            <div style={{ padding: '12px 14px', borderRadius: 10, background: 'rgba(217,119,6,.08)', border: '1px solid rgba(217,119,6,.3)', marginBottom: 12 }}>
              <div style={{ display: 'flex', gap: 8 }}>
                <AlertTriangle size={15} style={{ color: 'var(--amber, #d97706)', flexShrink: 0, marginTop: 2 }} />
                <div>
                  <div style={{ fontSize: '.82rem', fontWeight: 700, color: 'var(--text-0)', marginBottom: 4 }}>
                    Nothing carries forward from {space}
                  </div>
                  {/* The service's own words, so the screen and the server can
                      never say two different things. */}
                  <div style={{ fontSize: '.8rem', color: 'var(--text-2)', lineHeight: 1.6 }}>{pv.reason}</div>
                </div>
              </div>
            </div>
            <div style={{ fontSize: '.78rem', color: 'var(--text-3)', lineHeight: 1.6, marginBottom: 12 }}>
              {pv.existingCarryforwardId
                ? <>Open what the space already carries from the Change menu to settle it or take it off.</>
                : <>To end this tenancy, use <strong>Move out</strong> on the lease. What they owe stays theirs.</>}
            </div>
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={onClose}>Close</button>
            </div>
          </>
        )}

        {/* ── The four figures, then the press ─────────────────────────────── */}
        {!done && pv && pv.eligible && (
          <>
            {moved && (
              <div style={{ marginBottom: 10, padding: '8px 10px', borderRadius: 8, background: 'rgba(217,119,6,.08)', border: '1px solid rgba(217,119,6,.3)', color: 'var(--amber, #d97706)', fontSize: '.78rem', lineHeight: 1.6 }}>
                <strong>The figures moved while this was open</strong> — the ones below are the live ones now.
                {error ? <> {error}</> : <> Check them and press again.</>}
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 12 }}>
              <Figure
                title={`Becomes ${space}'s balance`}
                total={pv.carriesTotal}
                tone="var(--gold)"
                what={`Unpaid space rent. It follows the space onto whoever moves in next, and ${who} stays liable for it until it is paid — one balance, not two.`}
                lines={pv.carries}
              />
              <Figure
                title={`Stays ${who}'s own debt`}
                total={pv.staysTotal}
                tone="var(--text-0)"
                what="Utilities, fees, a deposit, a home payment. These never follow the space — they go with the person who ran them up."
                lines={pv.stays}
              />
              <Figure
                title="Dropped outright"
                total={pv.waivesTotal}
                tone="var(--text-2)"
                what="Late fees. Not moved and not kept: it was not possible for the next resident to be late, and a carried balance never gets one."
                lines={pv.waives}
              />
              <div style={{ padding: '12px 14px', borderRadius: 10, background: 'var(--bg-2)', border: '1px solid var(--border-0)' }}>
                <div style={{ fontSize: '.78rem', fontWeight: 700, color: 'var(--text-1)' }}>And the lease closes</div>
                <div style={{ fontSize: '.74rem', color: 'var(--text-3)', lineHeight: 1.5, marginTop: 4 }}>
                  {who} comes off it, {space} stops counting as occupied and is open to a new arrival. Their remaining
                  bills stop collecting new late fees from today.
                </div>
              </div>
            </div>

            <label style={{ display: 'block', fontSize: '.76rem', color: 'var(--text-3)', marginBottom: 10 }}>
              The day they left <span style={{ fontWeight: 400 }}>(blank = today, {sayDay(today)})</span>
              <input type="date" className="input" value={endDate} max={today}
                onChange={e => setEndDate(e.target.value)} style={{ display: 'block', marginTop: 4 }} />
            </label>
            <label style={{ display: 'block', fontSize: '.76rem', color: 'var(--text-3)', marginBottom: 12 }}>
              Note on the balance (optional)
              <input className="input" value={notes} maxLength={500} placeholder="e.g. home sold privately, buyer moving in"
                onChange={e => setNotes(e.target.value)} style={{ display: 'block', marginTop: 4, width: '100%' }} />
            </label>

            {error && !moved && (
              <div style={{ marginBottom: 10, padding: '8px 10px', borderRadius: 8, background: 'rgba(239,68,68,.08)', border: '1px solid rgba(239,68,68,.3)', color: 'var(--red)', fontSize: '.78rem' }}>
                {error}
              </div>
            )}

            <div className="modal-footer" style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-ghost" onClick={onClose} disabled={closeOut.isLoading}>Cancel</button>
              <button className="btn btn-primary" style={{ marginLeft: 'auto' }}
                disabled={closeOut.isLoading || preview.isFetching}
                onClick={() => closeOut.mutate()}>
                {closeOut.isLoading
                  ? 'Closing out…'
                  : `Close out — ${space} carries ${fmt(pv.carriesTotal)}`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
