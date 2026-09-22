/**
 * S652 — THE METER WALK, SHARED BY THE LANDLORD PORTAL AND THE TENANT PORTAL.
 *
 * Nic: "Curtis needs to be able to do and initiate the meter reading." A work
 * trader whose landlord ticked Read meters takes exactly this walk from their
 * Work Trade tab: the same blind entry, the same one-row-at-a-time locking, the
 * same rule that nobody types over a read a partner already landed. One
 * component, two portals, so the two never drift (see WorkTradePanel).
 *
 * The walk never issues a bill. When the last re-read lands the month waits for
 * the landlord's approval (platform-wide, S652).
 */
import { useState, useEffect, useMemo, useRef, CSSProperties } from 'react'
import { useQuery, useQueryClient } from 'react-query'
import { CheckCircle2, ChevronRight } from 'lucide-react'

export type WalkApi = { get: (url: string) => Promise<any>; post: (url: string, body?: any) => Promise<any> }

const fmt = (n: any) => n != null ? `$${Number(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}` : '—'
const lbl: CSSProperties = { fontSize:'.75rem', color:'var(--text-3)', marginBottom:4, display:'block' }
const UTILITY_ICONS: Record<string, string> = { water:'💧', gas:'🔥', electric:'⚡', sewer:'🚰', trash:'🗑️', propane:'🛢️' }
const UTILITY_UNITS: Record<string, string> = { water:'gal', gas:'therms', electric:'kWh', sewer:'gal', trash:'', propane:'gal' }
const monthLabel = (cycle: any) => new Date(String(cycle).slice(0, 10) + 'T00:00:00Z')
  .toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })

export function ReadingWalkModal({ run, mode, onClose, api }: { run: any; mode: 'read' | 'verify'; onClose: () => void; api: WalkApi }) {
  const qc = useQueryClient()
  const { data: meters = [], isLoading } = useQuery<any[]>(
    ['run-meters', run.id, mode],
    () => api.get(mode === 'verify'
      ? `/utility/reading-runs/${run.id}/double-checks`
      : `/utility/reading-runs/${run.id}/meters`))
  const [stepIdx, setStepIdx] = useState(0)
  const [values, setValues] = useState<Record<string, string>>({})
  // S607: a bill_amount master needs a second number — the provider's dollar
  // charge for the cycle — kept beside the usage entry, keyed the same way.
  const [bills, setBills] = useState<Record<string, string>>({})
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set())
  const [summary, setSummary] = useState<any | null>(null)
  const [error, setError] = useState<string | null>(null)

  // S631 (Nic, DIRECTIVE): "It's a shared workflow process... anybody that has
  // access can jump on and complete some or all of it... they can be done really
  // in any order. Nothing hinges on something else being done first... so
  // anybody could do any portion of the flow, and there's no blocking order and
  // no assigning. It's whoever jumps on and does what."
  //
  // Every meter is a step, DONE ONES INCLUDED. They used to be filtered out,
  // which made this a one-person queue: it always resumed at the next unread
  // meter and only moved forward, so somebody who came to enter the two water
  // masters had to click past twenty-seven submeters to reach them, and could
  // never see what a partner had already finished.
  //
  // Nothing here waits on anything else. That is not a new rule — S534 already
  // bills each unit from its own reads (ensureBillsForUnit on the lease's due
  // date), so a mobile home's water submeter bills that home whether or not the
  // master bill has arrived. The run is a checklist for people, never a gate on
  // money, and this list is what makes that visible.
  const steps = useMemo(() => {
    const byMeter = new Map<string, any>()
    for (const m of meters as any[]) {
      if (!byMeter.has(m.meterId)) byMeter.set(m.meterId, { ...m, unitNumbers: [] })
      if (m.unitNumber) byMeter.get(m.meterId).unitNumbers.push(m.unitNumber)
    }
    const unitSteps = new Map<string, { title: string; meters: any[] }>()
    const propertySteps: { title: string; meters: any[] }[] = []
    for (const m of byMeter.values()) {
      if (m.unitNumbers.length === 1) {
        const key = m.unitNumbers[0]
        if (!unitSteps.has(key)) unitSteps.set(key, { title: key, meters: [] })
        unitSteps.get(key)!.meters.push(m)
      } else {
        propertySteps.push({ title: m.label, meters: [m] })
      }
    }
    const sorted = [...unitSteps.values()]
      .sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }))
    return [...sorted, ...propertySteps]
  }, [meters])

  // Read on the server (by anyone, at any point) or saved in this sitting.
  const isDone = (m: any) => m.isRead || savedIds.has(m.meterId)
  const stepDone = (st: { meters: any[] }) => st.meters.every(isDone)
  const totalMeters = steps.reduce((s, st) => s + st.meters.length, 0)
  const doneMeters = steps.reduce((s, st) => s + st.meters.filter(isDone).length, 0)
  const step = steps[stepIdx]

  // Land on the first thing still outstanding rather than the top of the list —
  // a partner opening this after someone else has done half should not have to
  // scroll past their work.
  const jumpedRef = useRef(false)
  useEffect(() => {
    if (jumpedRef.current || !steps.length) return
    jumpedRef.current = true
    const first = steps.findIndex(st => !stepDone(st))
    if (first > 0) setStepIdx(first)
  }, [steps])
  // A submeter read is exactly the meter's digit width (odometer
  // convention — cycled-over meters are entered with leading zeros,
  // e.g. 000133). RUBS masters record a usage total: any length up to
  // the width.
  // S634: a master on the bill total NEVER needs a usage figure. It used to,
  // when submetered units on its line were carved out of the pool and that
  // carve-out was measured in usage. Nothing is carved out now, so the bill
  // alone is always enough — which is what an electric bill with peak/off-peak
  // tiers, demand charges and riders leaves you with anyway.
  const usageOptional = (m: any) => m.rubsBasis === 'bill_amount'
  const readOk = (m: any, v: string) => m.billingMethod === 'submeter'
    ? new RegExp(`^\\d{${m.digits}}$`).test(v)
    : usageOptional(m) ? (v === '' || /^[0-9]+$/.test(v)) : /^[0-9]+$/.test(v)
  const billOk = (m: any, v: string) => m.rubsBasis !== 'bill_amount' || /^\d+(\.\d{1,2})?$/.test(v)
  // S631 fix: `isDone` here, not `savedIds`. Including already-recorded meters
  // as steps (so the verification walk shows what a partner finished) left a
  // done step with an EMPTY, enabled input and a disabled Next — you landed on
  // somebody else's completed re-read and could not move past it without
  // retyping it. That is the "entered one and it locked up" Nic's brother hit.
  const stepComplete = !!step && step.meters.every(m =>
    isDone(m) || (readOk(m, values[m.meterId] ?? '') && billOk(m, bills[m.meterId] ?? '')))

  const [saving, setSaving] = useState(false)
  const next = async () => {
    if (!step || saving) return
    setSaving(true)
    setError(null)
    try {
      let last: any = null
      const saved = new Set(savedIds)
      for (const m of step.meters) {
        if (saved.has(m.meterId)) continue
        const r: any = await api.post(mode === 'verify'
          ? `/utility/reading-runs/${run.id}/double-checks/${m.meterId}`
          : `/utility/reading-runs/${run.id}/meters/${m.meterId}/reading`,
          { readingValue: Number(values[m.meterId] || 0),
            ...(m.rubsBasis === 'bill_amount' ? { billAmount: Number(bills[m.meterId]) } : {}) })
        saved.add(m.meterId)
        last = r?.data
      }
      setSavedIds(saved)
      // S631: the count on the page behind is read from the reading-runs query.
      // It was only refetched when this modal CLOSED, so after recording a
      // re-check the banner still showed the pre-save number — Nic's brother
      // entered one and was told "0 of 6 done", and reasonably concluded it had
      // not saved. It had; the page was just showing a stale copy.
      qc.invalidateQueries(['reading-runs'])
      // Main walk done → the system generated the verification list.
      if (last?.run?.status === 'double_check') { setSummary({ kind: 'verify_ready', dcTotal: last.dcTotal }); return }
      // Verification done → bills ran; show the money summary.
      if (last?.run?.status === 'completed') { setSummary({ kind: 'completed', ...last.run, escalated: last.escalated ?? 0 }); return }
      // S652: every re-read is in; the month waits for the landlord's approval.
      if (last?.remaining === 0) { setSummary({ kind: 'approve_ready' }); return }
      if (stepIdx < steps.length - 1) setStepIdx(stepIdx + 1)
      else onClose()
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Could not record the reading')
    } finally { setSaving(false) }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth:440 }} onClick={e=>e.stopPropagation()}>
        {summary ? (
          summary.kind === 'approve_ready' ? (
            <>
              <div className="modal-title" style={{ display:'flex', alignItems:'center', gap:8 }}><CheckCircle2 size={18} style={{ color:'var(--green)' }}/> Readings verified</div>
              <div style={{ fontSize:'.85rem', color:'var(--text-2)', lineHeight:1.6 }}>
                Every meter is read and checked. The month's bills are now with the landlord to look over and approve; they go out on each tenant's next invoice once approved.
              </div>
              <div className="modal-footer"><button className="btn btn-primary" onClick={onClose}>Done</button></div>
            </>
          ) : summary.kind === 'verify_ready' ? (
            <>
              <div className="modal-title" style={{ display:'flex', alignItems:'center', gap:8 }}><CheckCircle2 size={18} style={{ color:'var(--green)' }}/> Readings recorded</div>
              <div style={{ fontSize:'.85rem', color:'var(--text-2)', lineHeight:1.6 }}>
                All meters are in. A verification list of <b>{summary.dcTotal}</b> meter{summary.dcTotal === 1 ? '' : 's'} is ready — re-read those when you're back out, then the month's bills are reviewed and approved.
              </div>
              <div className="modal-footer"><button className="btn btn-primary" onClick={onClose}>Done</button></div>
            </>
          ) : (
            <>
              <div className="modal-title" style={{ display:'flex', alignItems:'center', gap:8 }}><CheckCircle2 size={18} style={{ color:'var(--green)' }}/> Reading run complete</div>
              <div style={{ fontSize:'.85rem', color:'var(--text-2)', lineHeight:1.6 }}>
                {monthLabel(summary.billingCycleMonth)} — {summary.billsCreated ?? 0} bill{(summary.billsCreated ?? 0) === 1 ? '' : 's'} totaling <b>{fmt(summary.billedTotal)}</b> generated.
                <div style={{ marginTop:8, fontSize:'.78rem', color:'var(--text-3)' }}>
                  Each charge is added automatically to that tenant's next monthly invoice. Spots without a responsible lease recorded a reading only — no charge.
                </div>
                {summary.escalated > 0 && (
                  <div style={{ marginTop:8, fontSize:'.78rem', color:'var(--amber, #d97706)' }}>
                    {summary.escalated} reading{summary.escalated === 1 ? '' : 's'} still need{summary.escalated === 1 ? 's' : ''} your review (rollover vs meter swap) — see the double-check card.
                  </div>
                )}
              </div>
              <div className="modal-footer"><button className="btn btn-primary" onClick={onClose}>Done</button></div>
            </>
          )
        ) : isLoading ? (
          <div style={{ color:'var(--text-3)', padding:16 }}>Loading…</div>
        ) : !step ? (
          // S631: the list now includes read meters, so an empty list means this
          // property has no readable meters at all — not that the work is done.
          <div style={{ color:'var(--text-3)', padding:16, fontSize:'.85rem' }}>
            No submeters or master meters are set up on this property yet.
          </div>
        ) : mode === 'read' ? (
          // S631: the monthly read is a LIST, not a wizard. The verification
          // re-read below stays one meter at a time on purpose — it is a blind
          // second read, and showing the whole list at once is precisely what it
          // must not do.
          <ReadingListForm run={run} meters={meters as any[]} api={api}
            onDone={setSummary} onClose={onClose} />
        ) : (
          <>
            <div className="modal-title" style={{ display:'flex', justifyContent:'space-between', alignItems:'baseline' }}>
              <span>{mode === 'verify' ? 'Verification walk' : 'Meter reading'} — {monthLabel(run.billingCycleMonth)}</span>
              <span className="mono" style={{ fontSize:'.75rem', color:'var(--text-3)' }}>{doneMeters}/{totalMeters}</span>
            </div>

            {/* S631: the whole list, any order. Tap what you're standing in
                front of — or what arrived in your post — instead of walking the
                queue to reach it. Done items stay visible so two people can see
                each other's progress without asking. */}
            <div style={{ display:'flex', flexWrap:'wrap', gap:5, marginBottom:12,
              maxHeight:112, overflowY:'auto', padding:'2px 0' }}>
              {steps.map((st, i) => {
                const done = stepDone(st)
                const here = i === stepIdx
                return (
                  <button key={st.title} type="button" onClick={() => setStepIdx(i)}
                    title={done ? 'Already read' : 'Not read yet'}
                    style={{ padding:'2px 8px', borderRadius:20, fontSize:'.68rem', fontWeight:700,
                      cursor:'pointer', whiteSpace:'nowrap',
                      border:`1px solid ${here ? 'var(--gold)' : done ? 'var(--border-0)' : 'rgba(201,162,39,.35)'}`,
                      background: here ? 'rgba(201,162,39,.14)' : done ? 'var(--bg-2)' : 'transparent',
                      color: done ? 'var(--text-3)' : here ? 'var(--gold)' : 'var(--text-1)' }}>
                    {done ? '✓ ' : ''}{st.title}
                  </button>
                )
              })}
            </div>

            <div style={{ fontWeight:700, fontSize:'1.15rem', marginBottom:2 }}>{step.title}</div>
            <div style={{ fontSize:'.7rem', color:'var(--text-3)', marginBottom:12 }}>
              {stepDone(step)
                ? 'Already read this cycle — entering again replaces it.'
                : 'Nothing waits on this. Each unit bills from its own reads.'}
            </div>

            <div style={{ display:'grid', gap:12 }}>
              {step.meters.map((m: any, i: number) => (
                <div key={m.meterId}>
                  <span style={lbl}>{UTILITY_ICONS[m.utilityType]} {m.utilityType[0].toUpperCase() + m.utilityType.slice(1)}{UTILITY_UNITS[m.utilityType] ? ` (${UTILITY_UNITS[m.utilityType]})` : ''}</span>
                  <input
                    className="form-input mono"
                    type="text"
                    inputMode="numeric"
                    maxLength={m.billingMethod === 'submeter' ? m.digits : 12}
                    autoComplete="off"
                    autoFocus={i === 0}
                    placeholder={m.billingMethod === 'submeter' ? `${m.digits}-digit read, e.g. ${'0'.repeat(Math.max(0, m.digits - 3))}133` : `usage total (up to ${m.digits} digits)`}
                    disabled={isDone(m)}
                    value={isDone(m) ? '✓ recorded' : (values[m.meterId] ?? '')}
                    onChange={e => {
                      const v = e.target.value.replace(/\D/g, '').slice(0, m.billingMethod === 'submeter' ? m.digits : 12)
                      setValues(prev => ({ ...prev, [m.meterId]: v }))
                    }}
                    onKeyDown={e => { if (e.key === 'Enter' && stepComplete && !saving) next() }}
                    style={{ width:'100%', fontSize:'1.05rem', letterSpacing:'.12em' }}
                  />
                  {/* S607 (Nic): the master step is the one place in the walk
                      where the number asked for is NOT the number on the meter
                      face. A master records the cycle's TOTAL USE off the
                      utility's own bill — the engine bills it directly, with no
                      prior read subtracted — so an odometer typed here prices
                      the whole park off a lifetime total. Say so at the field. */}
                  {m.billingMethod === 'rubs' && (
                    <div style={{ fontSize:'.72rem', color:'var(--text-3)', marginTop:4, lineHeight:1.45 }}>
                      {usageOptional(m)
                        ? 'Optional — leave blank if the bill has no single usage figure. The bill amount below is divided on its own.'
                        : 'Total used this cycle, from the utility bill — not the reading on the meter face. Required here: submetered units on this meter are subtracted from the pool.'}
                    </div>
                  )}
                  {/* S607: the dollar figure off the same bill. Entered here so
                      both numbers come from the one document in front of you —
                      splitting them across two screens is how they end up from
                      two different cycles. */}
                  {m.rubsBasis === 'bill_amount' && !isDone(m) && (
                    <div style={{ marginTop:10 }}>
                      <span style={lbl}>Amount the utility charged</span>
                      <input
                        className="form-input mono"
                        type="text"
                        inputMode="decimal"
                        autoComplete="off"
                        placeholder="total on the bill, e.g. 1284.50"
                        value={bills[m.meterId] ?? ''}
                        onChange={e => {
                          const v = e.target.value.replace(/[^\d.]/g, '').replace(/(\..*)\./g, '$1')
                          setBills(prev => ({ ...prev, [m.meterId]: v }))
                        }}
                        onKeyDown={e => { if (e.key === 'Enter' && stepComplete && !saving) next() }}
                        style={{ width:'100%', fontSize:'1.05rem', letterSpacing:'.12em' }}
                      />
                      <div style={{ fontSize:'.72rem', color:'var(--text-3)', marginTop:4, lineHeight:1.45 }}>
                        The whole bill — service charges and taxes included. It is divided across
                        the units on this meter, so the tenants see one blended rate.
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>

            {error && <div style={{ marginTop:10, fontSize:'.8rem', color:'var(--red)' }}>{error}</div>}

            <div className="modal-footer" style={{ display:'flex', justifyContent:'flex-end' }}>
              <button className="btn btn-primary" disabled={!stepComplete || saving} onClick={next}>
                {saving ? '…' : 'Next'} <ChevronRight size={13}/>
              </button>
            </div>
          </>
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
  const [rowErr, setRowErr] = useState<Record<string, string>>({})
  const [filter, setFilter] = useState<string>('all')
  const inputs = useRef<(HTMLInputElement | null)[]>([])

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

  const usageOptional = (m: any) => m.rubsBasis === 'bill_amount' && !m.hasSubmeteredUnits
  const readOk = (m: any, v: string) => m.billingMethod === 'submeter'
    ? new RegExp(`^\\d{${m.digits}}$`).test(v)
    : usageOptional(m) ? (v === '' || /^[0-9]+$/.test(v)) : /^[0-9]+$/.test(v)
  const billOk = (m: any, v: string) => m.rubsBasis !== 'bill_amount' || /^\d+(\.\d{1,2})?$/.test(v)
  const done = (m: any) => m.isRead || savedIds.has(m.meterId)

  const save = async (m: any) => {
    const v = values[m.meterId] ?? ''
    const b = bills[m.meterId] ?? ''
    if (savingIds.has(m.meterId)) return
    if (!readOk(m, v) || !billOk(m, b)) return
    if (v === '' && !usageOptional(m)) return
    setSavingIds(prev => new Set(prev).add(m.meterId))
    setRowErr(prev => ({ ...prev, [m.meterId]: '' }))
    try {
      const r: any = await api.post(`/utility/reading-runs/${run.id}/meters/${m.meterId}/reading`,
        { readingValue: Number(v || 0), ...(m.rubsBasis === 'bill_amount' ? { billAmount: Number(b) } : {}) })
      setSavedIds(prev => new Set(prev).add(m.meterId))
      // S631: keep the count on the page behind honest as each line lands —
      // two people work this list at once, and a stale number reads as a lost save.
      qc.invalidateQueries(['reading-runs'])
      // The last meter tips the run into its verification phase — surface that
      // rather than leaving somebody staring at a full list wondering.
      if (r?.data?.run?.status === 'double_check') onDone({ kind: 'verify_ready', dcTotal: r.data.dcTotal })
      if (r?.data?.run?.status === 'completed') onDone({ kind: 'completed', ...r.data.run })
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
          const isDone = done(m)
          const saving = savingIds.has(m.meterId)
          return (
            <div key={m.meterId} style={{ display:'grid', gridTemplateColumns:'1fr 150px',
              gap:10, alignItems:'center', padding:'7px 0',
              borderBottom:'1px solid var(--border-1, rgba(255,255,255,.06))', opacity: isDone ? .55 : 1 }}>
              <div style={{ minWidth:0 }}>
                <div style={{ fontSize:'.84rem', fontWeight:600, color:'var(--text-0)',
                  overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                  {isDone && <span style={{ color:'var(--green)' }}>✓ </span>}{m.title}
                </div>
                <div style={{ fontSize:'.68rem', color:'var(--text-3)' }}>
                  {UTILITY_ICONS[m.utilityType]} {m.utilityType}
                  {m.isMaster ? ' · master — total used this cycle, off the bill' : ` · ${m.digits}-digit read`}
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
              </div>
              <div>
                <input
                  ref={el => { inputs.current[i] = el }}
                  className="form-input mono" type="text" inputMode="numeric" autoComplete="off"
                  maxLength={m.billingMethod === 'submeter' ? m.digits : 12}
                  // S631: once it is in, it is in. Locking the field is what stops
                  // a stray keystroke on a row you already finished — and this row
                  // is gone entirely next time the window opens.
                  disabled={isDone || m.notYet}
                  placeholder={isDone ? 'recorded' : m.notYet ? 'not yet' : m.isMaster ? 'usage' : '0'.repeat(m.digits)}
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

