/**
 * S652 — THE METER WALK, SHARED BY THE LANDLORD PORTAL AND THE TENANT PORTAL.
 *
 * Nic: "Curtis needs to be able to do and initiate the meter reading." A work
 * trader whose landlord ticked Read meters takes exactly this walk from their
 * Work Trade tab: the same blind entry, the same one-row-at-a-time locking, the
 * same rule that nobody types over a read a partner already landed. One
 * component, two portals, so the two never drift (see WorkTradePanel).
 *
 * The walk never issues a bill. When the last read lands the month completes,
 * or waits for the landlord's review of anything flagged (S652).
 */
import { useState, useMemo, useRef } from 'react'
import { useQuery, useQueryClient } from 'react-query'
import { CheckCircle2 } from 'lucide-react'

export type WalkApi = {
  get: (url: string) => Promise<any>
  post: (url: string, body?: any) => Promise<any>
  // S652: the meter-face photo goes up as multipart before the number is posted.
  upload?: (url: string, form: FormData) => Promise<any>
}

const fmt = (n: any) => n != null ? `$${Number(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}` : '—'
const UTILITY_ICONS: Record<string, string> = { water:'💧', gas:'🔥', electric:'⚡', sewer:'🚰', trash:'🗑️', propane:'🛢️' }
const monthLabel = (cycle: any) => new Date(String(cycle).slice(0, 10) + 'T00:00:00Z')
  .toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })

/**
 * S652 (Nic): "get rid of the clean meters random blind reread. Just flag the
 * ones that need flagging, with limited to one window." The walk is the monthly
 * list and nothing else. A read the system doubts goes to the landlord's
 * "Readings to double-check" — the one window — and the month's bills go out
 * when the last of those is settled. (The old `mode` prop is accepted and
 * ignored so older callers keep compiling.)
 */
export function ReadingWalkModal({ run, onClose, api }: { run: any; mode?: 'read' | 'verify'; onClose: () => void; api: WalkApi }) {
  const { data: meters = [], isLoading } = useQuery<any[]>(
    ['run-meters', run.id],
    () => api.get(`/utility/reading-runs/${run.id}/meters`),
    // S653: always fresh on open. The portal caches queries for five minutes and
    // does not refetch on mount, so a walk reopened after a save showed the list
    // from before it.
    { staleTime: 0, refetchOnMount: 'always' })
  const [summary, setSummary] = useState<any | null>(null)
  const hasMeters = (meters as any[]).length > 0

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth:440 }} onClick={e=>e.stopPropagation()}>
        {summary ? (
          summary.kind === 'approve_ready' ? (
            <>
              <div className="modal-title" style={{ display:'flex', alignItems:'center', gap:8 }}><CheckCircle2 size={18} style={{ color:'var(--green)' }}/> All meters read</div>
              <div style={{ fontSize:'.85rem', color:'var(--text-2)', lineHeight:1.6 }}>
                Every meter is in. The month&apos;s bills are now with the landlord to look over and approve; they go out on each tenant&apos;s next invoice once approved.
              </div>
              <div className="modal-footer"><button className="btn btn-primary" onClick={onClose}>Done</button></div>
            </>
          ) : summary.kind === 'flagged' ? (
            <>
              <div className="modal-title" style={{ display:'flex', alignItems:'center', gap:8 }}><CheckCircle2 size={18} style={{ color:'var(--green)' }}/> All meters read</div>
              <div style={{ fontSize:'.85rem', color:'var(--text-2)', lineHeight:1.6 }}>
                Every meter is in. <b>{summary.flagged}</b> reading{summary.flagged === 1 ? ' looks' : 's look'} off and {summary.flagged === 1 ? 'is' : 'are'} with the landlord to double-check. The month&apos;s bills go out when {summary.flagged === 1 ? 'it is' : 'those are'} settled.
              </div>
              <div className="modal-footer"><button className="btn btn-primary" onClick={onClose}>Done</button></div>
            </>
          ) : (
            <>
              <div className="modal-title" style={{ display:'flex', alignItems:'center', gap:8 }}><CheckCircle2 size={18} style={{ color:'var(--green)' }}/> Reading run complete</div>
              <div style={{ fontSize:'.85rem', color:'var(--text-2)', lineHeight:1.6 }}>
                {monthLabel(summary.billingCycleMonth)} — {summary.billsCreated ?? 0} bill{(summary.billsCreated ?? 0) === 1 ? '' : 's'} totaling <b>{fmt(summary.billedTotal)}</b> generated.
                <div style={{ marginTop:8, fontSize:'.78rem', color:'var(--text-3)' }}>
                  Each charge is added automatically to that tenant&apos;s next monthly invoice. Spots without a responsible lease recorded a reading only — no charge.
                </div>
              </div>
              <div className="modal-footer"><button className="btn btn-primary" onClick={onClose}>Done</button></div>
            </>
          )
        ) : isLoading ? (
          <div style={{ color:'var(--text-3)', padding:16 }}>Loading…</div>
        ) : !hasMeters ? (
          <div style={{ color:'var(--text-3)', padding:16, fontSize:'.85rem' }}>
            No submeters or master meters are set up on this property yet.
          </div>
        ) : (
          <ReadingListForm run={run} meters={meters as any[]} api={api}
            onDone={setSummary} onClose={onClose} />
        )}
      </div>
    </div>
  )
}


function ReadingListForm({ run, meters, onDone, onClose, api }: {
  run: any; meters: any[]; onDone: (summary: any) => void; onClose: () => void; api: WalkApi
}) {
  const qc = useQueryClient()
  const [values, setValues] = useState<Record<string, string>>({})
  const [bills, setBills] = useState<Record<string, string>>({})
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set())
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set())
  // S652 (Nic): "if you accidentally have a typo, once I go to the next line, I
  // can't go back to the previous line." A line you saved in this sitting can be
  // reopened with Fix; saving again replaces your own read (the server lets the
  // same person correct their own work — somebody else's is still refused).
  const [fixingIds, setFixingIds] = useState<Set<string>>(new Set())
  const [rowErr, setRowErr] = useState<Record<string, string>>({})
  const [filter, setFilter] = useState<string>('all')
  const inputs = useRef<(HTMLInputElement | null)[]>([])
  // S652 (Nic): "take a picture of each meter for historical accuracy… make
  // the photo step optional… set it at the property level." One photo per
  // meter, taken on the row, uploaded with the number. A property with the
  // requirement on will not take the number without it.
  const [photos, setPhotos] = useState<Record<string, File>>({})
  const [previews, setPreviews] = useState<Record<string, string>>({})
  const takePhoto = (meterId: string, f: File | null) => {
    setPhotos(prev => { const n = { ...prev }; if (f) n[meterId] = f; else delete n[meterId]; return n })
    setPreviews(prev => { if (prev[meterId]) URL.revokeObjectURL(prev[meterId]); const n = { ...prev }; if (f) n[meterId] = URL.createObjectURL(f); else delete n[meterId]; return n })
  }
  const photoMissing = (m: any) => !!m.photoRequired && !m.hasPhoto && !photos[m.meterId] && m.billingMethod === 'submeter'

  // One row per meter, units in natural order, masters last — a master is read
  // off a bill at a desk, not on the walk, so it does not belong mid-list.
  const rows = useMemo(() => {
    const byMeter = new Map<string, any>()
    for (const m of meters) {
      if (!byMeter.has(m.meterId)) byMeter.set(m.meterId, { ...m, unitNumbers: [] })
      if (m.unitNumber) byMeter.get(m.meterId).unitNumbers.push(m.unitNumber)
    }
    const all = [...byMeter.values()].map(m => ({
      ...m,
      title: m.unitNumbers.length === 1 ? m.unitNumbers[0] : m.label,
      isMaster: m.billingMethod === 'rubs',
    }))
    // S648: meters read later (tenants due on their own day) sit below the
    // ones due now, ordered by when they are due.
    return all.sort((a, b) =>
      (a.isMaster ? 1 : 0) - (b.isMaster ? 1 : 0)
      || (a.notYet ? 1 : 0) - (b.notYet ? 1 : 0)
      || String(a.readBy ?? '').localeCompare(String(b.readBy ?? ''))
      || a.title.localeCompare(b.title, undefined, { numeric: true })
      || String(a.utilityType).localeCompare(String(b.utilityType)))
  }, [meters])

  // S631 (Nic, DIRECTIVE): "When I open the list again, I don't wanna see what's
  // already been done, just what still needs to be done... I don't want two
  // people reading meters and accidentally overwriting each other by typoing on
  // a spot that was already done."
  //
  // So the list is what is LEFT. `isRead` is the server's answer at load, which
  // means anything a partner finished before you opened this is simply not here
  // to be typed over. A row you complete in this sitting stays put, ticked, so
  // you can see your own work land — it disappears next time the window opens.
  // The count of the hidden ones is stated, because a list that silently omits
  // things is its own kind of confusing.
  const alreadyRead = rows.filter(r => r.isRead).length
  const outstanding = rows.filter(r => !r.isRead)
  const utilitiesLeft = [...new Set(outstanding.map(r => String(r.utilityType)))].sort()
  const shown = outstanding.filter(r =>
    filter === 'all' ? true
    : filter === 'masters' ? r.isMaster
    : filter === 'submeters' ? !r.isMaster
    : r.utilityType === filter)

  // S634/S653 (Nic): a master priced from the bill never needs a usage figure —
  // "the actual usage on the master meter is irrelevant." The RUBS units divide
  // the WHOLE bill; submetered units bill their own gallons. (This list still
  // demanded a usage total when submetered units sat on the line — so Oak
  // Park's Main master silently would not save with the bill alone.)
  const usageOptional = (m: any) => m.rubsBasis === 'bill_amount'
  const readOk = (m: any, v: string) => m.billingMethod === 'submeter'
    ? new RegExp(`^\\d{${m.digits}}$`).test(v)
    : usageOptional(m) ? (v === '' || /^[0-9]+$/.test(v)) : /^[0-9]+$/.test(v)
  const billOk = (m: any, v: string) => m.rubsBasis !== 'bill_amount' || /^\d+(\.\d{1,2})?$/.test(v)
  const done = (m: any) => m.isRead || savedIds.has(m.meterId)

  const save = async (m: any) => {
    const v = values[m.meterId] ?? ''
    const b = bills[m.meterId] ?? ''
    if (savingIds.has(m.meterId)) return
    // S653: say WHY a line did not save. A silent return looked like a save.
    if (v === '' && b === '') return                         // nothing typed yet
    if (!readOk(m, v) || (v === '' && !usageOptional(m))) {
      setRowErr(prev => ({ ...prev, [m.meterId]: m.isMaster ? 'Enter the usage total as a whole number.' : `Enter all ${m.digits} digits as the meter shows them.` }))
      return
    }
    if (!billOk(m, b)) {
      setRowErr(prev => ({ ...prev, [m.meterId]: 'Enter the bill total in dollars, e.g. 94.01.' }))
      return
    }
    if (photoMissing(m)) { setRowErr(prev => ({ ...prev, [m.meterId]: 'This property requires a photo of the meter face — take it first.' })); return }
    setSavingIds(prev => new Set(prev).add(m.meterId))
    setRowErr(prev => ({ ...prev, [m.meterId]: '' }))
    try {
      let photoUrl: string | undefined
      if (photos[m.meterId] && api.upload) {
        const fd = new FormData()
        fd.append('file', photos[m.meterId])
        const up: any = await api.upload(`/utility/reading-runs/${run.id}/meters/${m.meterId}/photo`, fd)
        photoUrl = up?.data?.url ?? up?.url
      }
      const r: any = await api.post(`/utility/reading-runs/${run.id}/meters/${m.meterId}/reading`,
        { readingValue: Number(v || 0), ...(photoUrl ? { photoUrl } : {}), ...(m.rubsBasis === 'bill_amount' ? { billAmount: Number(b) } : {}) })
      setSavedIds(prev => new Set(prev).add(m.meterId))
      setFixingIds(prev => { const n = new Set(prev); n.delete(m.meterId); return n })
      // S631: keep the count on the page behind honest as each line lands —
      // two people work this list at once, and a stale number reads as a lost save.
      // S653 (Nic): the LIST too — reopened within five minutes it showed the
      // cached "27 read" from before the save, wanting a meter already in.
      qc.invalidateQueries(['reading-runs'])
      qc.invalidateQueries(['run-meters', run.id])
      // The last meter tips the run into its verification phase — surface that
      // rather than leaving somebody staring at a full list wondering.
      if (r?.data?.run?.status === 'double_check') onDone({ kind: 'flagged', flagged: r.data.flagged ?? 0 })
      else if (r?.data?.run?.status === 'completed') onDone({ kind: 'completed', ...r.data.run })
      else if (r?.data?.awaitingApproval) onDone({ kind: 'approve_ready' })
    } catch (e: any) {
      setRowErr(prev => ({ ...prev, [m.meterId]: e?.response?.data?.error || 'Could not save' }))
    } finally {
      setSavingIds(prev => { const n = new Set(prev); n.delete(m.meterId); return n })
    }
  }

  const doneCount = rows.filter(done).length
  const laterCount = outstanding.filter(r => r.notYet).length
  const leftCount = outstanding.filter(r => !savedIds.has(r.meterId) && !r.notYet).length
  const chip = (key: string, label: string) => (
    <button key={key} type="button" onClick={() => setFilter(key)}
      style={{ padding:'3px 10px', borderRadius:20, fontSize:'.72rem', fontWeight:700, cursor:'pointer',
        border:`1px solid ${filter === key ? 'var(--gold)' : 'var(--border-0)'}`,
        background: filter === key ? 'rgba(201,162,39,.1)' : 'var(--bg-2)',
        color: filter === key ? 'var(--gold)' : 'var(--text-2)' }}>{label}</button>
  )

  return (
    <>
      <div className="modal-title" style={{ display:'flex', justifyContent:'space-between', alignItems:'baseline' }}>
        <span>Meter readings — {monthLabel(run.billingCycleMonth)}</span>
        <span className="mono" style={{ fontSize:'.75rem', color:'var(--text-3)' }}>{doneCount}/{rows.length}</span>
      </div>

      <div style={{ fontSize:'.74rem', color:'var(--text-2)', marginBottom:10, lineHeight:1.5 }}>
        What&apos;s still to read. Each line saves on its own, so anyone can pick up the rest later,
        in any order — nothing waits on anything else.
        {alreadyRead > 0 && (
          <> <span style={{ color:'var(--text-3)' }}>
            {alreadyRead} already read this cycle and not shown.
          </span></>
        )}
      </div>

      <div style={{ display:'flex', flexWrap:'wrap', gap:6, marginBottom:12 }}>
        {chip('all', `All (${outstanding.length})`)}
        {utilitiesLeft.length > 1 && utilitiesLeft.map(u =>
          chip(u, `${UTILITY_ICONS[u] ?? ''} ${u[0].toUpperCase() + u.slice(1)}`))}
        {outstanding.some(r => r.isMaster) && chip('masters', 'Master bills')}
        {outstanding.some(r => r.isMaster) && outstanding.some(r => !r.isMaster) && chip('submeters', 'Submeters')}
      </div>

      <div style={{ maxHeight:'52vh', overflowY:'auto', margin:'0 -4px', padding:'0 4px' }}>
        {shown.map((m, i) => {
          const fixing = fixingIds.has(m.meterId)
          const isDone = done(m) && !fixing
          const saving = savingIds.has(m.meterId)
          const startFix = () => {
            setFixingIds(prev => new Set(prev).add(m.meterId))
            setTimeout(() => { inputs.current[i]?.focus(); inputs.current[i]?.select() }, 0)
          }
          return (
            <div key={m.meterId} style={{ display:'grid', gridTemplateColumns:'1fr 150px',
              gap:10, alignItems:'center', padding:'7px 0',
              borderBottom:'1px solid var(--border-1, rgba(255,255,255,.06))', opacity: isDone ? .55 : 1 }}>
              <div style={{ minWidth:0 }}>
                <div style={{ fontSize:'.84rem', fontWeight:600, color:'var(--text-0)',
                  overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                  {isDone && <span style={{ color:'var(--green)' }}>✓ </span>}{m.title}
                  {isDone && savedIds.has(m.meterId) && (
                    <button type="button" onClick={startFix}
                      style={{ marginLeft:8, fontSize:'.68rem', fontWeight:700, color:'var(--gold)', background:'none', border:'none', padding:0, cursor:'pointer' }}>
                      Fix
                    </button>
                  )}
                  {fixing && <span style={{ marginLeft:8, fontSize:'.68rem', color:'var(--gold)' }}>fixing — Enter saves</span>}
                </div>
                <div style={{ fontSize:'.68rem', color:'var(--text-3)' }}>
                  {UTILITY_ICONS[m.utilityType]} {m.utilityType}
                  {m.isMaster
                    ? (m.rubsBasis === 'bill_amount' ? ' · master — enter the bill total; usage not needed' : ' · master — total used this cycle, off the bill')
                    : ` · ${m.digits}-digit read`}
                </div>
                {/* S648 (Nic): read the last business day before this tenant's due date. */}
                {m.notYet && (
                  <div style={{ fontSize:'.68rem', color:'var(--gold)' }}>
                    Read on {new Date(m.readBy + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} — the business day before this tenant&apos;s rent is due
                  </div>
                )}
                {rowErr[m.meterId] && (
                  <div style={{ fontSize:'.68rem', color:'var(--red)' }}>{rowErr[m.meterId]}</div>
                )}
                {/* S652: the meter face — offered on every submeter, demanded
                    only where the property says so. Never on a master: that is
                    read off the provider's bill. */}
                {!m.isMaster && !isDone && !m.notYet && !!api.upload && (
                  <div style={{ display:'flex', alignItems:'center', gap:8, marginTop:4 }}>
                    <label style={{ fontSize:'.7rem', color: photoMissing(m) ? 'var(--gold)' : 'var(--text-2)', cursor:'pointer', border:'1px dashed var(--border-2, var(--border-1))', borderRadius:6, padding:'2px 8px' }}>
                      📷 {photos[m.meterId] ? 'Retake' : (m.photoRequired ? 'Photo required' : 'Photo')}
                      <input type="file" accept="image/*" capture="environment" style={{ display:'none' }}
                        onChange={e => { takePhoto(m.meterId, e.target.files?.[0] ?? null); e.target.value = '' }} />
                    </label>
                    {previews[m.meterId] && <img src={previews[m.meterId]} alt="" style={{ height:34, width:34, objectFit:'cover', borderRadius:5, border:'1px solid var(--border-1)' }} />}
                    {m.hasPhoto && !photos[m.meterId] && <span style={{ fontSize:'.66rem', color:'var(--text-3)' }}>photo on file</span>}
                  </div>
                )}
              </div>
              <div>
                <input
                  ref={el => { inputs.current[i] = el }}
                  className="form-input mono" type="text" inputMode="numeric" autoComplete="off"
                  maxLength={m.billingMethod === 'submeter' ? m.digits : 12}
                  // S631: once it is in, it is in. Locking the field is what stops
                  // a stray keystroke on a row you already finished — and this row
                  // is gone entirely next time the window opens. S652: Fix (above)
                  // reopens a line you saved in this sitting.
                  disabled={isDone || m.notYet}
                  placeholder={isDone ? 'recorded' : m.notYet ? 'not yet' : m.isMaster ? (m.rubsBasis === 'bill_amount' ? 'usage (optional)' : 'usage') : '0'.repeat(m.digits)}
                  value={values[m.meterId] ?? ''}
                  onChange={e => setValues(prev => ({ ...prev,
                    [m.meterId]: e.target.value.replace(/\D/g, '').slice(0, m.billingMethod === 'submeter' ? m.digits : 12) }))}
                  onBlur={() => save(m)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') { e.preventDefault(); save(m); inputs.current[i + 1]?.focus() }
                  }}
                  style={{ width:'100%', fontSize:'.95rem', letterSpacing:'.08em',
                    borderColor: saving ? 'var(--gold)' : undefined }} />
                {m.rubsBasis === 'bill_amount' && (
                  <input
                    className="form-input mono" type="text" inputMode="decimal" autoComplete="off"
                    disabled={isDone}
                    placeholder="bill $" value={bills[m.meterId] ?? ''}
                    onChange={e => setBills(prev => ({ ...prev,
                      [m.meterId]: e.target.value.replace(/[^\d.]/g, '').replace(/(\..*)\./g, '$1') }))}
                    onBlur={() => save(m)}
                    style={{ width:'100%', fontSize:'.9rem', marginTop:5 }} />
                )}
              </div>
            </div>
          )
        })}
      </div>

      <div className="modal-footer" style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
        <span style={{ fontSize:'.72rem', color:'var(--text-3)' }}>
          {leftCount === 0 ? 'Nothing left to read today.' : `${leftCount} still to read`}
          {laterCount > 0 ? ` · ${laterCount} later this month` : ''}
        </span>
        <button className="btn btn-primary" onClick={onClose}>Done for now</button>
      </div>
    </>
  )
}

