import { useState, useEffect, useMemo, CSSProperties } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { useSearchParams } from 'react-router-dom'
import { apiGet, apiPost } from '../lib/api'
import { METER_READING_DEFAULT_DIGITS, PROPANE_SPLIT_FOUR_MIN_GALLONS, PROPANE_SPLIT_MIN_GALLONS, propaneSplitOptions } from '@gam/shared'
import { ClipboardList, Receipt, ChevronRight, CheckCircle2, AlertTriangle } from 'lucide-react'

const fmt = (n: any) => n != null ? `$${Number(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}` : '—'
// Meter reads are odometer values — display with leading zeros at the
// meter's own digit width (a cycled-over 6-digit meter reads 000133).
const fmtRead = (v: any, digits: any) => String(Math.trunc(Number(v))).padStart(Number(digits) || METER_READING_DEFAULT_DIGITS, '0')
const lbl: CSSProperties = { fontSize:'.75rem', color:'var(--text-3)', marginBottom:4, display:'block' }

const UTILITY_ICONS: Record<string, string> = { water:'💧', gas:'🔥', electric:'⚡', sewer:'🚰', trash:'🗑️' }
const UTILITY_UNITS: Record<string, string> = { water:'gal', gas:'therms', electric:'kWh', sewer:'gal', trash:'' }
const BILL_STATUS: Record<string, string> = { unbilled:'badge-muted', billed:'badge-amber', paid:'badge-green', waived:'badge-muted' }

const monthLabel = (cycle: any) => new Date(String(cycle).slice(0, 10) + 'T00:00:00Z')
  .toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })

// The end-of-month reading-run workflow (Nic's design; replaced the S531
// manual record-reading/generate-bills surface). A run opens on the last
// business day of each month and prompts the manager; the guided walk
// steps meter-to-meter, auto-calculates usage for leased spots, and the
// charges ride each tenant's next monthly invoice automatically.
export function UtilityMetersPage() {
  const qc = useQueryClient()
  const [searchParams] = useSearchParams()
  const { data: properties = [] } = useQuery<any[]>('properties', () => apiGet('/properties'))
  const [propertyId, setPropertyId] = useState(() => searchParams.get('propertyId') || '')
  useEffect(() => {
    if (!propertyId && (properties as any[]).length === 1) setPropertyId((properties as any[])[0].id)
  }, [properties, propertyId])

  const { data: meters = [] } = useQuery<any[]>(
    ['utility-meters', propertyId],
    () => apiGet(`/utility/meters?propertyId=${propertyId}`),
    { enabled: !!propertyId }
  )
  const { data: units = [] } = useQuery<any[]>(
    ['units-for-property', propertyId],
    () => apiGet(`/units?propertyId=${propertyId}`),
    { enabled: !!propertyId }
  )
  const { data: bills = [] } = useQuery<any[]>('utility-bills', () => apiGet('/utility/bills'))
  const { data: runs = [] } = useQuery<any[]>(
    ['reading-runs', propertyId],
    () => apiGet(`/utility/reading-runs?propertyId=${propertyId}`),
    { enabled: !!propertyId }
  )
  const { data: flagged = [] } = useQuery<any[]>(
    ['flagged-readings', propertyId],
    () => apiGet(`/utility/readings/flagged?propertyId=${propertyId}`),
    { enabled: !!propertyId }
  )
  const openRun = (runs as any[]).find(r => r.status === 'open' || r.status === 'double_check')

  const [walkRun, setWalkRun] = useState<any | null>(null)
  const [reviewReading, setReviewReading] = useState<any | null>(null)

  const invalidate = () => {
    qc.invalidateQueries(['utility-meters', propertyId])
    qc.invalidateQueries('utility-bills')
    qc.invalidateQueries(['reading-runs', propertyId])
    qc.invalidateQueries(['flagged-readings', propertyId])
  }

  const openRunMut = useMutation(
    () => apiPost('/utility/reading-runs', { propertyId }),
    { onSuccess: (r: any) => { invalidate(); if (r?.data) setWalkRun(r.data) },
      onError: (e: any) => alert(e?.response?.data?.error || 'Could not open a reading run') }
  )

  // S534: force-complete escape hatch — an unread submeter now HOLDS the
  // unit's invoice, so the landlord needs a way to close out a run with
  // an unreadable meter. Unread/flagged meters produce no bill this cycle.
  const forceCompleteMut = useMutation(
    (runId: string) => apiPost(`/utility/reading-runs/${runId}/complete`, {}),
    { onSuccess: invalidate,
      onError: (e: any) => alert(e?.response?.data?.error || 'Could not complete the run') }
  )

  const propertyBills = (bills as any[]).filter(b => !propertyId || (units as any[]).some(u => u.id === b.unitId))
  const lastCompleted = (runs as any[]).find(r => r.status === 'completed')

  return (
    <div>
      <div className="page-header">
        <div style={{ display:'flex', alignItems:'center', gap:14 }}>
          <div>
            <h1 className="page-title">Utilities</h1>
            <p className="page-subtitle">Monthly meter reading runs and per-unit utility billing</p>
          </div>
          {(properties as any[]).length > 1 && (
            <select className="form-select" value={propertyId} onChange={e=>setPropertyId(e.target.value)} style={{ width:'auto', minWidth:200 }}>
              <option value="" disabled>Select a property…</option>
              {(properties as any[]).map((p:any)=><option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          )}
        </div>
      </div>

      {!propertyId ? (
        <div style={{ padding:'48px 24px', textAlign:'center', color:'var(--text-3)', border:'1px dashed var(--border-1)', borderRadius:12 }}>
          Select a property to manage its meters and utility billing.
        </div>
      ) : (
        <>
          {/* ── READING RUN ────────────────────────────────── */}
          {openRun ? (
            <div className="card" style={{ marginBottom:24, display:'flex', alignItems:'center', gap:16, borderColor:'var(--gold)', flexWrap:'wrap' }}>
              <ClipboardList size={28} style={{ color:'var(--gold)', flexShrink:0 }}/>
              <div style={{ flex:1, minWidth:220 }}>
                <div style={{ fontWeight:700 }}>
                  {openRun.status === 'double_check' ? 'Verification walk' : 'Meter readings due'} — {monthLabel(openRun.billingCycleMonth)}
                </div>
                <div style={{ fontSize:'.78rem', color:'var(--text-3)', marginTop:2 }}>
                  {openRun.status === 'double_check'
                    ? `${openRun.dcDone} of ${openRun.dcTotal} re-checks entered. Units with reads already bill on their invoice date — re-checks just verify them.`
                    : `${openRun.metersRead} of ${openRun.metersTotal} meters read. Each unit bills on its tenant's next invoice as soon as its meters are read — an unread meter holds only that unit's invoice.`}
                </div>
              </div>
              <button className="btn btn-primary" onClick={()=>setWalkRun(openRun)}>
                {openRun.status === 'double_check'
                  ? (openRun.dcDone > 0 ? 'Continue verification' : 'Start verification')
                  : (openRun.metersRead > 0 ? 'Continue reading' : 'Start reading')} <ChevronRight size={14}/>
              </button>
              {(openRun.status === 'double_check' || openRun.metersRead > 0) && (
                <button className="btn btn-primary btn-sm" disabled={forceCompleteMut.isLoading}
                  onClick={()=>{ if (confirm('Complete this run now? Unread meters produce no bill this cycle and their held invoices release. Flagged reads still need your review before their unit\'s invoice goes out.')) forceCompleteMut.mutate(openRun.id) }}>
                  Complete now
                </button>
              )}
            </div>
          ) : (meters as any[]).some((m:any) => m.billingMethod !== 'master_bill_to_landlord') ? (
            <div className="card" style={{ marginBottom:24, display:'flex', alignItems:'center', gap:16, flexWrap:'wrap' }}>
              <CheckCircle2 size={24} style={{ color:'var(--text-3)', flexShrink:0 }}/>
              <div style={{ flex:1, minWidth:220, fontSize:'.82rem', color:'var(--text-2)' }}>
                {lastCompleted
                  ? <>Last reading run: {monthLabel(lastCompleted.billingCycleMonth)} — {lastCompleted.billsCreated ?? 0} bill{(lastCompleted.billsCreated ?? 0) === 1 ? '' : 's'} ({fmt(lastCompleted.billedTotal)}). The next run opens on the last business day of the month.</>
                  : <>No reading run yet. Runs open automatically on the last business day of each month.</>}
              </div>
              <button className="btn btn-primary btn-sm" disabled={openRunMut.isLoading} onClick={()=>openRunMut.mutate()}>Start early</button>
            </div>
          ) : null}

          {/* ── DOUBLE-CHECK QUEUE ─────────────────────────── */}
          {(flagged as any[]).length > 0 && (
            <div className="card" style={{ marginBottom:24, borderColor:'var(--amber, #d97706)' }}>
              <div style={{ display:'flex', alignItems:'center', gap:8, fontWeight:700, marginBottom:8 }}>
                <AlertTriangle size={16} style={{ color:'var(--amber, #d97706)' }}/> Readings to double-check
              </div>
              <div style={{ fontSize:'.75rem', color:'var(--text-3)', marginBottom:10 }}>
                The reading run flagged these for a second look. Re-check the meter, then correct the value or confirm it.
              </div>
              <div style={{ display:'grid', gap:6 }}>
                {(flagged as any[]).map((r:any) => (
                  <div key={r.id} style={{ display:'flex', alignItems:'center', gap:12, padding:'8px 12px', borderRadius:8, background:'var(--bg-2)' }}>
                    <span style={{ fontSize:'.85rem', fontWeight:600 }}>{UTILITY_ICONS[r.utilityType]} {r.unitNumber ? `Unit ${r.unitNumber}` : r.label}</span>
                    <span style={{ fontSize:'.78rem', color:'var(--text-3)' }}>
                      <span className="mono">{String(r.billingCycleMonth).slice(0,7)} · entered {fmtRead(r.readingValue, r.digits)} · previous {r.priorReadingValue != null ? fmtRead(r.priorReadingValue, r.digits) : '—'}</span>
                      {r.reviewNote && <div style={{ fontSize:'.7rem', marginTop:2 }}>{r.reviewNote}</div>}
                    </span>
                    <button className="btn btn-primary btn-sm" style={{ marginLeft:'auto' }} onClick={()=>setReviewReading(r)}>Review</button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── BILLS (read-only status; runs create these) ── */}
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:12 }}>
            <h2 style={{ fontSize:'.95rem', margin:0, display:'flex', alignItems:'center', gap:8 }}><Receipt size={16}/> Utility Bills</h2>
          </div>
          <div className="card" style={{ padding:0, overflowX:'auto' }}>
            {propertyBills.length === 0 ? (
              <div className="empty-state" style={{ padding:40 }}><Receipt size={36}/><h3>No utility bills</h3><p>Complete a reading run — leased units bill automatically and the charge rides the tenant's next monthly invoice.</p></div>
            ) : (
              <table className="data-table" style={{ minWidth:800 }}>
                <thead><tr><th>Cycle</th><th>Unit</th><th>Meter</th><th>Reads</th><th>Usage</th><th>Amount</th><th>Tax</th><th>Status</th></tr></thead>
                <tbody>
                  {propertyBills.map((b:any) => (
                    <tr key={b.id}>
                      <td className="mono" style={{ fontSize:'.75rem' }}>{String(b.billingCycleMonth).slice(0,7)}</td>
                      <td className="mono">{b.unitNumber}</td>
                      <td style={{ fontSize:'.78rem' }}>{UTILITY_ICONS[b.utilityType]} {b.meterLabel}</td>
                      <td className="mono" style={{ fontSize:'.75rem', color:'var(--text-3)' }}>{b.readingStart != null && b.readingEnd != null ? `${fmtRead(b.readingStart, b.digits)} → ${fmtRead(b.readingEnd, b.digits)}` : '—'}</td>
                      <td className="mono" style={{ fontSize:'.78rem' }}>{b.usageAmount != null ? `${Number(b.usageAmount).toLocaleString()} ${UTILITY_UNITS[b.utilityType] || ''}` : '—'}</td>
                      <td className="mono" style={{ fontWeight:600 }}>{fmt(b.chargeAmount)}</td>
                      <td className="mono" style={{ fontSize:'.78rem', color:'var(--text-3)' }}>{Number(b.taxAmount) > 0 ? `+${fmt(b.taxAmount)}` : '—'}</td>
                      <td><span className={`badge ${BILL_STATUS[b.status] || 'badge-muted'}`}>{b.status === 'billed' ? 'on next invoice' : b.status}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          {/* ── PROPANE (tank fills — gas for RVs) ─────────── */}
          <PropaneSection propertyId={propertyId} property={(properties as any[]).find((p:any)=>p.id===propertyId)} units={units as any[]} onChanged={invalidate} />

          {/* ── UTILITY TAX RATES ──────────────────────────── */}
          <TaxRatesCard propertyId={propertyId} />
        </>
      )}

      {walkRun && (
        <ReadingWalkModal run={walkRun} mode={walkRun.status === 'double_check' ? 'verify' : 'read'} onClose={()=>{ setWalkRun(null); invalidate() }} />
      )}
      {reviewReading && (
        <ReviewReadingModal reading={reviewReading} onClose={()=>{ setReviewReading(null); invalidate() }} />
      )}
    </div>
  )
}

// ── DOUBLE-CHECK REVIEW ──────────────────────────────────────────────
// The reviewer (unlike the blind reader) sees both values — that's the
// point of the check. A genuine low read must say WHY it's lower,
// because the money differs: rollover bills wrap-around usage
// ((1,000,000 − previous) + current); a meter swap/reset bills nothing
// that cycle. Resolving re-bills the cycle automatically if its run
// already completed.
function ReviewReadingModal({ reading, onClose }: { reading: any; onClose: () => void }) {
  const [value, setValue] = useState('')
  const [reason, setReason] = useState<'rollover' | 'swap' | null>(null)
  const digits = Number(reading.digits) || METER_READING_DEFAULT_DIGITS
  const valueOk = new RegExp(`^\\d{${digits}}$`).test(value)
  const prior = reading.priorReadingValue != null ? Number(reading.priorReadingValue) : null
  // Flags come in two kinds now: below-previous outliers and
  // suspicious-high usage. The "why is it lower" question only applies
  // when the value being KEPT is below the previous read — confirming a
  // high-usage flag needs no reason.
  const enteredIsLow = prior != null && Number(reading.readingValue) < prior
  const correctionIsLow = valueOk && prior != null && Number(value) < prior
  const reasonNeeded = (value === '' && enteredIsLow) || correctionIsLow
  const resolve = useMutation(
    (p: { correctedValue?: number; rollover?: boolean }) => apiPost(`/utility/readings/${reading.id}/resolve-review`, p),
    { onSuccess: onClose, onError: (e: any) => alert(e?.response?.data?.error || 'Could not resolve') }
  )
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth:420 }} onClick={e=>e.stopPropagation()}>
        <div className="modal-title">Double-check — {reading.unitNumber ? `Unit ${reading.unitNumber}` : reading.label}</div>
        <div style={{ background:'var(--bg-2)', borderRadius:10, padding:'12px 14px', marginBottom:12, fontSize:'.82rem' }}>
          <div style={{ display:'flex', justifyContent:'space-between' }}>
            <span style={{ color:'var(--text-3)' }}>Previous reading</span>
            <span className="mono" style={{ fontWeight:600 }}>{prior != null ? fmtRead(prior, digits) : '—'}</span>
          </div>
          <div style={{ display:'flex', justifyContent:'space-between', marginTop:6 }}>
            <span style={{ color:'var(--text-3)' }}>Entered this cycle</span>
            <span className="mono" style={{ fontWeight:600, color:'var(--amber, #d97706)' }}>{fmtRead(reading.readingValue, digits)}</span>
          </div>
          {reading.reviewNote && <div style={{ marginTop:8, fontSize:'.75rem', color:'var(--text-3)' }}>{reading.reviewNote}</div>}
        </div>
        <div>
          <span style={lbl}>Corrected value ({UTILITY_UNITS[reading.utilityType] || 'units'}) — leave empty if the entered read is right</span>
          <input className="form-input mono" type="text" inputMode="numeric" maxLength={digits} autoComplete="off" placeholder={`${digits}-digit read`}
            value={value}
            onChange={e => setValue(e.target.value.replace(/\D/g, '').slice(0, digits))}
            style={{ width:'100%', letterSpacing:'.12em' }}/>
        </div>
        {reasonNeeded && (
          <div style={{ marginTop:12 }}>
            <span style={lbl}>Why is the read lower than last month?</span>
            <div style={{ display:'grid', gap:6 }}>
              <label style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 12px', borderRadius:8, background:'var(--bg-2)', cursor:'pointer', fontSize:'.82rem' }}>
                <input type="radio" name="low-reason" checked={reason==='rollover'} onChange={()=>setReason('rollover')} />
                Meter rolled past {'9'.repeat(digits)} — bill the wrap-around usage
              </label>
              <label style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 12px', borderRadius:8, background:'var(--bg-2)', cursor:'pointer', fontSize:'.82rem' }}>
                <input type="radio" name="low-reason" checked={reason==='swap'} onChange={()=>setReason('swap')} />
                Meter was replaced or reset — no charge this cycle
              </label>
            </div>
          </div>
        )}
        <div className="modal-footer" style={{ display:'flex', justifyContent:'space-between' }}>
          <button className="btn btn-primary" disabled={value !== '' || (enteredIsLow && reason == null) || resolve.isLoading}
            onClick={()=>resolve.mutate({ rollover: enteredIsLow && reason === 'rollover' })}>Entered read is correct</button>
          <button className="btn btn-primary" disabled={!valueOk || (correctionIsLow && reason == null) || resolve.isLoading}
            onClick={()=>resolve.mutate({ correctedValue: Number(value), ...(correctionIsLow ? { rollover: reason === 'rollover' } : {}) })}>Save correction</button>
        </div>
      </div>
    </div>
  )
}

// ── GUIDED READING WALK ──────────────────────────────────────────────
// Blind linear entry (Nic's design): one step per UNIT with a typed
// input per applicable utility meter (e.g. RV 01 electric + RV 01
// water). NO prior reading is shown anywhere — prevents biasing the
// reader. The only button is Next: it saves the step's readings and
// advances. When the last meter is read the backend completes the run
// and bills land on the tenants' next monthly invoices.
function ReadingWalkModal({ run, mode, onClose }: { run: any; mode: 'read' | 'verify'; onClose: () => void }) {
  const { data: meters = [], isLoading } = useQuery<any[]>(
    ['run-meters', run.id, mode],
    () => apiGet(mode === 'verify'
      ? `/utility/reading-runs/${run.id}/double-checks`
      : `/utility/reading-runs/${run.id}/meters`))
  const [stepIdx, setStepIdx] = useState(0)
  const [values, setValues] = useState<Record<string, string>>({})
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set())
  const [summary, setSummary] = useState<any | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Group the payload into steps: one per unit (its unread meters,
  // ordered by utility), multi-unit/unassigned meters (RUBS masters)
  // as their own property-level steps at the end. Built once per open —
  // already-read meters are excluded so a resumed walk continues where
  // it stopped.
  const steps = useMemo(() => {
    const byMeter = new Map<string, any>()
    for (const m of meters as any[]) {
      if (!byMeter.has(m.meterId)) byMeter.set(m.meterId, { ...m, unitNumbers: [] })
      if (m.unitNumber) byMeter.get(m.meterId).unitNumbers.push(m.unitNumber)
    }
    const unitSteps = new Map<string, { title: string; meters: any[] }>()
    const propertySteps: { title: string; meters: any[] }[] = []
    for (const m of byMeter.values()) {
      if (m.isRead) continue
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

  const totalMeters = steps.reduce((s, st) => s + st.meters.length, 0)
  const doneMeters = savedIds.size
  const step = steps[stepIdx]
  // A submeter read is exactly the meter's digit width (odometer
  // convention — cycled-over meters are entered with leading zeros,
  // e.g. 000133). RUBS masters record a usage total: any length up to
  // the width.
  const readOk = (m: any, v: string) => m.billingMethod === 'submeter'
    ? new RegExp(`^\\d{${m.digits}}$`).test(v)
    : new RegExp(`^\\d{1,${m.digits}}$`).test(v)
  const stepComplete = !!step && step.meters.every(m =>
    savedIds.has(m.meterId) || readOk(m, values[m.meterId] ?? ''))

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
        const r: any = await apiPost(mode === 'verify'
          ? `/utility/reading-runs/${run.id}/double-checks/${m.meterId}`
          : `/utility/reading-runs/${run.id}/meters/${m.meterId}/reading`,
          { readingValue: Number(values[m.meterId]) })
        saved.add(m.meterId)
        last = r?.data
      }
      setSavedIds(saved)
      // Main walk done → the system generated the verification list.
      if (last?.run?.status === 'double_check') { setSummary({ kind: 'verify_ready', dcTotal: last.dcTotal }); return }
      // Verification done → bills ran; show the money summary.
      if (last?.run?.status === 'completed') { setSummary({ kind: 'completed', ...last.run, escalated: last.escalated ?? 0 }); return }
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
          summary.kind === 'verify_ready' ? (
            <>
              <div className="modal-title" style={{ display:'flex', alignItems:'center', gap:8 }}><CheckCircle2 size={18} style={{ color:'var(--green)' }}/> Readings recorded</div>
              <div style={{ fontSize:'.85rem', color:'var(--text-2)', lineHeight:1.6 }}>
                All meters are in. A verification list of <b>{summary.dcTotal}</b> meter{summary.dcTotal === 1 ? '' : 's'} is ready — re-read those when you're back out, then billing runs automatically.
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
          <div style={{ color:'var(--text-3)', padding:16, fontSize:'.85rem' }}>All meters on this run are already read.</div>
        ) : (
          <>
            <div className="modal-title" style={{ display:'flex', justifyContent:'space-between', alignItems:'baseline' }}>
              <span>{mode === 'verify' ? 'Verification walk' : 'Meter reading'} — {monthLabel(run.billingCycleMonth)}</span>
              <span className="mono" style={{ fontSize:'.75rem', color:'var(--text-3)' }}>{doneMeters}/{totalMeters}</span>
            </div>

            <div style={{ fontWeight:700, fontSize:'1.15rem', marginBottom:12 }}>{step.title}</div>

            <div style={{ display:'grid', gap:12 }}>
              {step.meters.map((m: any, i: number) => (
                <div key={m.meterId}>
                  <span style={lbl}>{UTILITY_ICONS[m.utilityType]} {m.utilityType[0].toUpperCase() + m.utilityType.slice(1)}{UTILITY_UNITS[m.utilityType] ? ` (${UTILITY_UNITS[m.utilityType]})` : ''}</span>
                  <input
                    className="form-input mono"
                    type="text"
                    inputMode="numeric"
                    maxLength={m.digits}
                    autoComplete="off"
                    autoFocus={i === 0}
                    placeholder={m.billingMethod === 'submeter' ? `${m.digits}-digit read, e.g. ${'0'.repeat(Math.max(0, m.digits - 3))}133` : `usage total (up to ${m.digits} digits)`}
                    disabled={savedIds.has(m.meterId)}
                    value={savedIds.has(m.meterId) ? '✓ recorded' : (values[m.meterId] ?? '')}
                    onChange={e => {
                      const v = e.target.value.replace(/\D/g, '').slice(0, m.digits)
                      setValues(prev => ({ ...prev, [m.meterId]: v }))
                    }}
                    onKeyDown={e => { if (e.key === 'Enter' && stepComplete && !saving) next() }}
                    style={{ width:'100%', fontSize:'1.05rem', letterSpacing:'.12em' }}
                  />
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

// ── PROPANE (Nic, S533) ──────────────────────────────────────────────
// RV gas = propane tank fills billed in gallons at a per-fill PPG
// (independent of POS pricing). Splits are 2 or 4 only and
// property-opt-in; the gallon thresholds gating each split are
// LANDLORD-SET per property (S534 — shared constants are just the
// defaults). Payment 1 is due immediately, the rest ride monthly
// invoices under normal late-fee rules.
function PropaneSection({ propertyId, property, units, onChanged }: { propertyId: string; property: any; units: any[]; onChanged: () => void }) {
  const qc = useQueryClient()
  const { data: fills = [] } = useQuery<any[]>(
    ['propane-fills', propertyId],
    () => apiGet(`/propane/fills?propertyId=${propertyId}`),
    { enabled: !!propertyId }
  )
  const [fillModal, setFillModal] = useState(false)
  const allowSplits = !!property?.propaneAllowInstallments
  const splitMin = Number(property?.propaneSplitMinGallons ?? PROPANE_SPLIT_MIN_GALLONS)
  const splitFourMin = Number(property?.propaneSplitFourMinGallons ?? PROPANE_SPLIT_FOUR_MIN_GALLONS)
  const [minDraft, setMinDraft] = useState(String(splitMin))
  const [fourDraft, setFourDraft] = useState(String(splitFourMin))
  useEffect(() => { setMinDraft(String(splitMin)); setFourDraft(String(splitFourMin)) }, [propertyId, splitMin, splitFourMin])

  const settingsMut = useMutation(
    (p: any) => apiPost('/propane/settings', { propertyId, ...p }),
    { onSuccess: () => { qc.invalidateQueries('properties'); onChanged() },
      onError: (e: any) => alert(e?.response?.data?.error || 'Could not save setting') }
  )
  const saveThreshold = (key: 'splitMinGallons' | 'splitFourMinGallons', draft: string, current: number) => {
    const v = Math.trunc(Number(draft))
    if (!draft || !Number.isFinite(v) || v < 1 || v === current) {
      // Reset a blank/invalid/unchanged draft back to the saved value.
      setMinDraft(String(splitMin)); setFourDraft(String(splitFourMin))
      return
    }
    settingsMut.mutate({ [key]: v })
  }

  return (
    <>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', margin:'24px 0 12px' }}>
        <h2 style={{ fontSize:'.95rem', margin:0 }}>🔥 Propane</h2>
        <button className="btn btn-primary btn-sm" onClick={()=>setFillModal(true)}>Record Tank Fill</button>
      </div>
      <div className="card" style={{ padding:0 }}>
        <div style={{ display:'flex', gap:24, padding:'10px 16px', borderBottom:'1px solid var(--border-1)', flexWrap:'wrap' }}>
          <label style={{ display:'flex', alignItems:'center', gap:8, fontSize:'.8rem', cursor:'pointer' }}>
            <input type="checkbox" checked={allowSplits} disabled={settingsMut.isLoading}
              onChange={e=>settingsMut.mutate({ allowInstallments: e.target.checked })}/>
            Allow tenants to split fills into payments (2 or 4)
          </label>
          {allowSplits && (
            <>
              <label style={{ display:'flex', alignItems:'center', gap:6, fontSize:'.72rem', color:'var(--text-3)' }}>
                2 payments from
                <input className="form-input mono" type="text" inputMode="numeric" value={minDraft}
                  onChange={e=>{ if (e.target.value===''||/^\d+$/.test(e.target.value)) setMinDraft(e.target.value) }}
                  onBlur={()=>saveThreshold('splitMinGallons', minDraft, splitMin)}
                  style={{ width:64, padding:'4px 8px', fontSize:'.78rem' }}/>
                gal
              </label>
              <label style={{ display:'flex', alignItems:'center', gap:6, fontSize:'.72rem', color:'var(--text-3)' }}>
                4 payments from
                <input className="form-input mono" type="text" inputMode="numeric" value={fourDraft}
                  onChange={e=>{ if (e.target.value===''||/^\d+$/.test(e.target.value)) setFourDraft(e.target.value) }}
                  onBlur={()=>saveThreshold('splitFourMinGallons', fourDraft, splitFourMin)}
                  style={{ width:64, padding:'4px 8px', fontSize:'.78rem' }}/>
                gal
              </label>
            </>
          )}
          <span style={{ fontSize:'.72rem', color:'var(--text-3)', alignSelf:'center' }}>
            A new fill makes any prior fill balance due immediately.
          </span>
        </div>
        {(fills as any[]).length === 0 ? (
          <div style={{ padding:24, fontSize:'.8rem', color:'var(--text-3)', textAlign:'center' }}>
            No tank fills recorded. Fills bill the unit's tenant in gallons at the price you set per fill.
          </div>
        ) : (
          <table className="data-table" style={{ minWidth:760 }}>
            <thead><tr><th>Date</th><th>Unit</th><th>Tenant</th><th>Gallons</th><th>$/gal</th><th>Tax</th><th>Total</th><th>Plan</th><th>Paid</th><th>Remaining</th></tr></thead>
            <tbody>
              {(fills as any[]).map((f:any) => (
                <tr key={f.id}>
                  <td className="mono" style={{ fontSize:'.75rem' }}>{String(f.fillDate).slice(0,10)}</td>
                  <td className="mono">{f.unitNumber}</td>
                  <td style={{ fontSize:'.8rem' }}>{f.tenantName}</td>
                  <td className="mono">{Number(f.gallons).toLocaleString()}</td>
                  <td className="mono" style={{ fontSize:'.78rem' }}>{fmt(f.pricePerGallon)}</td>
                  <td className="mono" style={{ fontSize:'.78rem', color:'var(--text-3)' }}>{Number(f.taxAmount) > 0 ? `+${fmt(f.taxAmount)}` : '—'}</td>
                  <td className="mono" style={{ fontWeight:600 }}>{fmt(f.totalAmount)}</td>
                  <td style={{ fontSize:'.78rem' }}>{f.installmentCount === 1 ? 'Paid in full' : `${f.installmentCount} payments`}</td>
                  <td className="mono" style={{ fontSize:'.78rem' }}>{f.installmentsPaid}/{f.installmentCount}</td>
                  <td className="mono" style={{ fontSize:'.78rem', color: Number(f.balanceRemaining) > 0 ? 'var(--amber, #d97706)' : 'var(--green)' }}>{fmt(f.balanceRemaining)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {fillModal && (
        <PropaneFillModal propertyId={propertyId} units={units} allowSplits={allowSplits}
          splitMin={splitMin} splitFourMin={splitFourMin}
          onClose={()=>{ setFillModal(false); qc.invalidateQueries(['propane-fills', propertyId]); onChanged() }}/>
      )}
    </>
  )
}

function PropaneFillModal({ propertyId, units, allowSplits, splitMin, splitFourMin, onClose }: { propertyId: string; units: any[]; allowSplits: boolean; splitMin: number; splitFourMin: number; onClose: () => void }) {
  const [unitId, setUnitId] = useState('')
  const { data: fills = [] } = useQuery<any[]>(
    ['propane-fills', propertyId], () => apiGet(`/propane/fills?propertyId=${propertyId}`))
  const priorBalance = (fills as any[])
    .filter((f:any) => f.unitId === unitId)
    .reduce((s:number, f:any) => s + Number(f.balanceRemaining || 0), 0)
  const [gallons, setGallons] = useState('')
  const [ppg, setPpg] = useState('')
  const [installments, setInstallments] = useState(1)
  const { data: taxRates = [] } = useQuery<any[]>(
    ['utility-tax-rates', propertyId], () => apiGet(`/utility/tax-rates?propertyId=${propertyId}`))
  const taxPct = Number((taxRates as any[]).find((r:any)=>r.utilityType==='propane')?.taxRatePct || 0)

  const g = Number(gallons) || 0
  const subtotal = Math.round(g * (Number(ppg) || 0) * 100) / 100
  const tax = Math.round(subtotal * taxPct) / 100
  const total = Math.round((subtotal + tax) * 100) / 100
  const splitOpts = allowSplits ? propaneSplitOptions(g, splitMin, splitFourMin) : [1]
  useEffect(() => { if (!splitOpts.includes(installments)) setInstallments(1) }, [gallons, allowSplits])

  const mut = useMutation(
    () => apiPost('/propane/fills', { unitId, gallons: g, pricePerGallon: Number(ppg), installments }),
    { onSuccess: onClose, onError: (e: any) => alert(e?.response?.data?.error || 'Could not record fill') }
  )

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth:440 }} onClick={e=>e.stopPropagation()}>
        <div className="modal-title">Record Tank Fill</div>
        <div style={{ display:'grid', gap:10 }}>
          <div><span style={lbl}>Unit</span>
            <select className="form-select" value={unitId} onChange={e=>setUnitId(e.target.value)} style={{ width:'100%' }}>
              <option value="" disabled>Select unit…</option>
              {units.map((u:any)=><option key={u.id} value={u.id}>Unit {u.unitNumber}</option>)}
            </select>
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
            <div><span style={lbl}>Gallons</span>
              <input className="form-input mono" type="text" inputMode="decimal" placeholder="e.g. 120"
                value={gallons} onChange={e=>{ const v=e.target.value; if (v===''||/^\d*\.?\d*$/.test(v)) setGallons(v) }} style={{ width:'100%' }}/></div>
            <div><span style={lbl}>Price per gallon ($)</span>
              <input className="form-input mono" type="text" inputMode="decimal" placeholder="e.g. 3.49"
                value={ppg} onChange={e=>{ const v=e.target.value; if (v===''||/^\d*\.?\d*$/.test(v)) setPpg(v) }} style={{ width:'100%' }}/></div>
          </div>
          <div><span style={lbl}>Payment plan</span>
            <div style={{ display:'flex', gap:8 }}>
              {[1,2,4].map(n => (
                <label key={n} style={{ flex:1, display:'flex', alignItems:'center', justifyContent:'center', gap:6, padding:'8px 4px', borderRadius:8,
                    background:'var(--bg-2)', cursor: splitOpts.includes(n) ? 'pointer' : 'not-allowed', opacity: splitOpts.includes(n) ? 1 : .35, fontSize:'.8rem' }}>
                  <input type="radio" name="propane-split" disabled={!splitOpts.includes(n)} checked={installments===n} onChange={()=>setInstallments(n)}/>
                  {n === 1 ? 'Pay in full' : `${n} payments`}
                </label>
              ))}
            </div>
            {!allowSplits && <div style={{ fontSize:'.7rem', color:'var(--text-3)', marginTop:4 }}>Splits are off for this property (toggle above).</div>}
            {allowSplits && g > 0 && g < splitMin && <div style={{ fontSize:'.7rem', color:'var(--text-3)', marginTop:4 }}>Fills under {splitMin} gal can't split.</div>}
            {allowSplits && g >= splitMin && g < splitFourMin && <div style={{ fontSize:'.7rem', color:'var(--text-3)', marginTop:4 }}>4-payment plans need a {splitFourMin}+ gal fill.</div>}
          </div>
          {priorBalance > 0 && (
            <div style={{ fontSize:'.75rem', color:'var(--amber, #d97706)' }}>
              This unit has {fmt(priorBalance)} outstanding from a previous fill — recording this fill makes that entire balance due immediately.
            </div>
          )}
          <div style={{ background:'var(--bg-2)', borderRadius:10, padding:'10px 14px', fontSize:'.82rem' }}>
            <div style={{ display:'flex', justifyContent:'space-between' }}><span style={{ color:'var(--text-3)' }}>Propane</span><span className="mono">{fmt(subtotal)}</span></div>
            {taxPct > 0 && <div style={{ display:'flex', justifyContent:'space-between', marginTop:4 }}><span style={{ color:'var(--text-3)' }}>Tax ({taxPct}%)</span><span className="mono">{fmt(tax)}</span></div>}
            <div style={{ display:'flex', justifyContent:'space-between', marginTop:4, fontWeight:700 }}><span>Total</span><span className="mono" style={{ color:'var(--gold)' }}>{fmt(total)}</span></div>
            {installments > 1 && <div style={{ fontSize:'.7rem', color:'var(--text-3)', marginTop:6 }}>Payment 1 of {installments} ({fmt(Math.floor(total/installments*100)/100)}) is due now; the rest ride the next monthly invoices.</div>}
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!unitId || g <= 0 || ppg === '' || mut.isLoading} onClick={()=>mut.mutate()}>
            {mut.isLoading ? 'Saving…' : 'Record Fill'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── UTILITY TAX RATES (landlord-entered) ─────────────────────────────
function TaxRatesCard({ propertyId }: { propertyId: string }) {
  const qc = useQueryClient()
  const { data: rates = [] } = useQuery<any[]>(
    ['utility-tax-rates', propertyId], () => apiGet(`/utility/tax-rates?propertyId=${propertyId}`))
  const [draft, setDraft] = useState<Record<string, string>>({})
  const TYPES = ['electric','water','sewer','trash','propane']
  const current = (t: string) => (rates as any[]).find((r:any)=>r.utilityType===t)?.taxRatePct
  const mut = useMutation(
    (p: { utilityType: string; taxRatePct: number }) => apiPost('/utility/tax-rates', { propertyId, ...p }),
    { onSuccess: () => qc.invalidateQueries(['utility-tax-rates', propertyId]),
      onError: (e: any) => alert(e?.response?.data?.error || 'Could not save tax rate') }
  )
  return (
    <>
      <h2 style={{ fontSize:'.95rem', margin:'24px 0 12px' }}>Utility tax rates</h2>
      <div className="card">
        <div style={{ fontSize:'.75rem', color:'var(--text-3)', marginBottom:10 }}>
          Set the tax you're required to collect per utility — check your local rules. Tax shows as a separate amount on each charge; changing a rate never rewrites past bills.
        </div>
        <div style={{ display:'flex', gap:14, flexWrap:'wrap' }}>
          {TYPES.map(t => (
            <div key={t} style={{ minWidth:120 }}>
              <span style={lbl}>{UTILITY_ICONS[t] || '🔥'} {t[0].toUpperCase()+t.slice(1)} (%)</span>
              <input className="form-input mono" type="text" inputMode="decimal" placeholder="0"
                value={draft[t] ?? (current(t) != null ? String(Number(current(t))) : '')}
                onChange={e=>{ const v=e.target.value; if (v===''||/^\d*\.?\d*$/.test(v)) setDraft(prev=>({ ...prev, [t]: v })) }}
                onBlur={()=>{ const v = draft[t]; if (v != null && v !== '' && Number(v) !== Number(current(t) ?? -1)) mut.mutate({ utilityType: t, taxRatePct: Number(v) }) }}
                style={{ width:'100%' }}/>
            </div>
          ))}
        </div>
      </div>
    </>
  )
}
