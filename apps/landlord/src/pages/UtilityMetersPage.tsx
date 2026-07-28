import { useState, useEffect, useMemo, CSSProperties } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { useSearchParams } from 'react-router-dom'
import { apiGet, apiPost, apiDelete, apiPatch } from '../lib/api'
import { METER_READING_DEFAULT_DIGITS, PROPANE_SPLIT_FOUR_MIN_GALLONS, PROPANE_SPLIT_MIN_GALLONS, propaneSplitOptions, METER_READ_MANUAL_REASONS, METER_READ_REASON_LABEL } from '@gam/shared'
import { ClipboardList, Receipt, ChevronRight, CheckCircle2, AlertTriangle, Gauge, Plus, Trash2, X, ClipboardCheck, Wrench } from 'lucide-react'
import { toast, appConfirm } from '../components/dialogs'
import { usePerms } from '../lib/permissions'

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
  const { can } = usePerms()
  // Front desk (utility.read_meters) can take reads; only the landlord
  // (properties.edit) sees prior/entered values, meter setup, and reviews.
  const canReview = can('properties.edit')
  const canRead = canReview || can('utility.read_meters')
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
  // Flagged double-check queue shows entered + prior values side by side —
  // LANDLORD ONLY (the endpoint 403s otherwise). Front desk never fetches it.
  const { data: flagged = [] } = useQuery<any[]>(
    ['flagged-readings', propertyId],
    () => apiGet(`/utility/readings/flagged?propertyId=${propertyId}`),
    { enabled: !!propertyId && canReview }
  )
  // Live, calendar-derived "reads due" to-do (turnovers + move-outs on
  // submetered spots with no post-departure read yet).
  const { data: readsDue = [] } = useQuery<any[]>(
    ['reads-due', propertyId],
    () => apiGet(`/utility/reads-due?propertyId=${propertyId}`),
    { enabled: !!propertyId && canRead }
  )
  const openRun = (runs as any[]).find(r => r.status === 'open' || r.status === 'double_check')

  const [walkRun, setWalkRun] = useState<any | null>(null)
  const [reviewReading, setReviewReading] = useState<any | null>(null)
  const [specialRead, setSpecialRead] = useState<{ meterId?: string; unitNumber?: string; reason?: string; label?: string } | null>(null)

  const invalidate = () => {
    qc.invalidateQueries(['utility-meters', propertyId])
    qc.invalidateQueries('utility-bills')
    qc.invalidateQueries(['reading-runs', propertyId])
    qc.invalidateQueries(['flagged-readings', propertyId])
    qc.invalidateQueries(['reads-due', propertyId])
  }

  const openRunMut = useMutation(
    () => apiPost('/utility/reading-runs', { propertyId }),
    { onSuccess: (r: any) => { invalidate(); if (r?.data) setWalkRun(r.data) },
      onError: (e: any) => toast.error(e?.response?.data?.error || 'Could not open a reading run') }
  )

  // S534: force-complete escape hatch — an unread submeter now HOLDS the
  // unit's invoice, so the landlord needs a way to close out a run with
  // an unreadable meter. Unread/flagged meters produce no bill this cycle.
  const forceCompleteMut = useMutation(
    (runId: string) => apiPost(`/utility/reading-runs/${runId}/complete`, {}),
    { onSuccess: invalidate,
      onError: (e: any) => toast.error(e?.response?.data?.error || 'Could not complete the run') }
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
                  onClick={()=>{ appConfirm('Complete this run now? Unread meters produce no bill this cycle and their held invoices release. Flagged reads still need your review before their unit\'s invoice goes out.', { confirmLabel: 'Complete run' }).then(ok => { if (ok) forceCompleteMut.mutate(openRun.id) }) }}>
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

          {/* ── READS DUE (live to-do: turnovers + move-outs) ── */}
          {(readsDue as any[]).length > 0 && (
            <div className="card" style={{ marginBottom:24, borderColor:'var(--gold)' }}>
              <div style={{ display:'flex', alignItems:'center', gap:8, fontWeight:700, marginBottom:8 }}>
                <ClipboardCheck size={16} style={{ color:'var(--gold)' }}/> Meter reads due
              </div>
              <div style={{ fontSize:'.75rem', color:'var(--text-3)', marginBottom:10 }}>
                A stay ended on these submetered spots — read each meter to close it out. Extend or cancel a stay and it drops off automatically.
              </div>
              <div style={{ display:'grid', gap:6 }}>
                {(readsDue as any[]).map((r:any) => (
                  <div key={`${r.meterId}-${r.unitId}`} style={{ display:'flex', alignItems:'center', gap:12, padding:'8px 12px', borderRadius:8, background:'var(--bg-2)' }}>
                    <span style={{ fontSize:'.85rem', fontWeight:600 }}>{UTILITY_ICONS[r.utilityType]} {r.unitNumber ? `Unit ${r.unitNumber}` : r.meterLabel}</span>
                    <span style={{ fontSize:'.75rem', color:'var(--text-3)' }}>
                      {r.who ? `${r.who} — ` : ''}left {String(r.departedOn).slice(0,10)}
                    </span>
                    <button className="btn btn-primary btn-sm" style={{ marginLeft:'auto' }}
                      onClick={()=>setSpecialRead({ meterId: r.meterId, unitNumber: r.unitNumber, reason: r.reason, label: r.meterLabel })}>
                      Read meter
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── DOUBLE-CHECK QUEUE (landlord only — shows values) ── */}
          {canReview && (flagged as any[]).length > 0 && (
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

          {/* ── METER SETUP (S558: masters, submeters, RUBS groups, flat-rate) ── */}
          {/* Meter setup is LANDLORD-only (broken toggle, rates, links). */}
          {canReview && (
            <MeterConfigSection propertyId={propertyId} meters={meters as any[]} units={units as any[]} onChanged={invalidate} />
          )}

          {/* ── BILLS (read-only status; runs create these) ── */}
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:12 }}>
            <h2 style={{ fontSize:'.95rem', margin:0, display:'flex', alignItems:'center', gap:8 }}><Receipt size={16}/> Utility Bills</h2>
            {canRead && (meters as any[]).some((m:any)=>m.billingMethod==='submeter') && (
              <button className="btn btn-primary btn-sm" onClick={()=>setSpecialRead({})}>
                <Gauge size={13}/> Take a reading
              </button>
            )}
          </div>
          <div className="card" style={{ padding:0, overflowX:'auto' }}>
            {propertyBills.length === 0 ? (
              <div className="empty-state" style={{ padding:40 }}><Receipt size={36}/><h3>No utility bills</h3><p>Complete a reading run — leased units bill automatically and the charge rides the tenant's next monthly invoice.</p></div>
            ) : (
              <table className="data-table" style={{ minWidth:800 }}>
                {/* S560: raw start→end reads are LANDLORD-only history — front desk
                    sees them on the actual invoice, not as a lookupable history here. */}
                <thead><tr><th>Cycle</th><th>Unit</th><th>Meter</th>{canReview && <th>Reads</th>}<th>Usage</th><th>Amount</th><th>Tax</th><th>Status</th></tr></thead>
                <tbody>
                  {propertyBills.map((b:any) => (
                    <tr key={b.id}>
                      <td className="mono" style={{ fontSize:'.75rem' }}>{String(b.billingCycleMonth).slice(0,7)}</td>
                      <td className="mono">{b.unitNumber}</td>
                      <td style={{ fontSize:'.78rem' }}>{UTILITY_ICONS[b.utilityType]} {b.meterLabel}</td>
                      {canReview && <td className="mono" style={{ fontSize:'.75rem', color:'var(--text-3)' }}>{b.readingStart != null && b.readingEnd != null ? `${fmtRead(b.readingStart, b.digits)} → ${fmtRead(b.readingEnd, b.digits)}` : '—'}</td>}
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
      {specialRead && (
        <SpecialReadModal preset={specialRead} meters={(meters as any[]).filter(m=>m.billingMethod==='submeter')}
          onClose={()=>{ setSpecialRead(null); invalidate() }} />
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
    { onSuccess: onClose, onError: (e: any) => toast.error(e?.response?.data?.error || 'Could not resolve') }
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

// ── SPECIAL / OFF-CYCLE READ (S559) ──────────────────────────────────
// Blind entry: pick the spot, pick a reason (or it's pre-set from the
// reads-due to-do), punch the number. NO prior value is ever shown.
// move_out_final bills the departing tenant; every other reason is a
// reference/baseline read that resets the baseline for the next stay.
function SpecialReadModal({ preset, meters, onClose }: { preset: { meterId?: string; unitNumber?: string; reason?: string; label?: string }; meters: any[]; onClose: () => void }) {
  const presetReason = !!preset.reason && preset.reason !== 'monthly_cycle'
  const [meterId, setMeterId] = useState(preset.meterId || (meters.length === 1 ? meters[0].id : ''))
  const [reason, setReason] = useState<string>(presetReason ? preset.reason! : (METER_READ_MANUAL_REASONS[0] as string))
  const [note, setNote] = useState('')
  const [value, setValue] = useState('')
  const meter = meters.find(m => m.id === meterId)
  const digits = Number(meter?.digits) || METER_READING_DEFAULT_DIGITS
  const valueOk = new RegExp(`^\\d{1,${digits}}$`).test(value)
  const save = useMutation(
    () => apiPost(`/utility/meters/${meterId}/reads`, { readingValue: Number(value), reason, reasonNote: note || undefined }),
    { onSuccess: (r:any) => { toast(r?.data?.billed ? 'Read recorded — final bill created' : 'Reading recorded'); onClose() },
      onError: (e:any) => toast.error(e?.response?.data?.error || 'Could not record the reading') }
  )
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth:420 }} onClick={e=>e.stopPropagation()}>
        <div className="modal-title" style={{ display:'flex', alignItems:'center', gap:8 }}>
          <Wrench size={16} style={{ color:'var(--gold)' }}/> {preset.unitNumber ? `Read — Unit ${preset.unitNumber}` : 'Take a reading'}
        </div>
        {presetReason && (
          <div style={{ fontSize:'.8rem', color:'var(--text-3)', marginBottom:12 }}>
            {preset.reason === 'move_out_final'
              ? 'Final move-out read — the departing tenant is billed for usage since the last read.'
              : 'Stay turnover — reference read, no charge. Sets the baseline for the next guest.'}
          </div>
        )}
        {!preset.meterId && (
          <div style={{ marginBottom:12 }}>
            <span style={lbl}>Spot / meter</span>
            <select className="form-select" value={meterId} onChange={e=>setMeterId(e.target.value)} style={{ width:'100%' }}>
              <option value="" disabled>Select a submeter…</option>
              {meters.map(m => <option key={m.id} value={m.id}>{UTILITY_ICONS[m.utilityType]} {m.label}</option>)}
            </select>
          </div>
        )}
        {!presetReason && (
          <div style={{ marginBottom:12 }}>
            <span style={lbl}>Reason</span>
            <select className="form-select" value={reason} onChange={e=>setReason(e.target.value)} style={{ width:'100%' }}>
              {METER_READ_MANUAL_REASONS.map(r => <option key={r} value={r}>{METER_READ_REASON_LABEL[r]}</option>)}
            </select>
          </div>
        )}
        {reason === 'other' && (
          <div style={{ marginBottom:12 }}>
            <span style={lbl}>Note</span>
            <input className="form-input" value={note} onChange={e=>setNote(e.target.value)} maxLength={500} placeholder="Why this read?" style={{ width:'100%' }}/>
          </div>
        )}
        <div style={{ marginBottom:12 }}>
          <span style={lbl}>Reading{meter ? ` (${UTILITY_UNITS[meter.utilityType] || 'units'})` : ''}</span>
          <input className="form-input mono" type="text" inputMode="numeric" maxLength={digits} autoFocus autoComplete="off"
            value={value} onChange={e=>setValue(e.target.value.replace(/\D/g,'').slice(0, digits))}
            placeholder={`up to ${digits} digits`} style={{ width:'100%', fontSize:'1.05rem', letterSpacing:'.12em' }}/>
        </div>
        <div className="modal-footer" style={{ display:'flex', justifyContent:'flex-end', gap:8 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!meterId || !valueOk || save.isLoading} onClick={()=>save.mutate()}>
            {save.isLoading ? '…' : 'Record'}
          </button>
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
      onError: (e: any) => toast.error(e?.response?.data?.error || 'Could not save setting') }
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
    { onSuccess: onClose, onError: (e: any) => toast.error(e?.response?.data?.error || 'Could not record fill') }
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
      onError: (e: any) => toast.error(e?.response?.data?.error || 'Could not save tax rate') }
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

// ── S558 (Nic): METER SETUP ──────────────────────────────────
// Add master meters, attach submeters to a master (metered exclusion), assign a
// RUBS group of units to a master, and flat-rate meters. Supports the one-master
// park layout: a RUBS master carrying BOTH submeters (their usage excluded) AND
// a RUBS unit group (the remainder, split by occupancy).
const RUBS_ALLOC_LABEL: Record<string,string> = { occupant_count:'by occupancy (headcount)', sqft:'by sq ft', bedrooms:'by bedrooms', equal_split:'equal split' }
function rateLabel(m: any) { return m.ratePerUnit != null ? `${fmt(m.ratePerUnit)}/${UTILITY_UNITS[m.utilityType] || 'unit'}` : 'no rate set' }
function methodLabel(m: any): string {
  if (m.billingMethod === 'rubs') return `RUBS master · ${RUBS_ALLOC_LABEL[m.rubsAllocationMethod] || m.rubsAllocationMethod} · ${rateLabel(m)}`
  if (m.billingMethod === 'submeter') return `Submeter · ${rateLabel(m)}`
  if (m.billingMethod === 'flat_rate') return `Flat rate · ${fmt(m.baseFee)}/unit`
  if (m.billingMethod === 'master_bill_to_landlord') return 'Master meter · landlord pays'
  return m.billingMethod
}

function MeterConfigSection({ propertyId, meters, units, onChanged }: {
  propertyId: string; meters: any[]; units: any[]; onChanged: () => void
}) {
  const [showAdd, setShowAdd] = useState(false)
  const unitLabel = (id: string) => { const u = units.find(x => x.id === id); return u ? `Unit ${u.unitNumber}` : id.slice(0, 8) }
  const masters = meters.filter(m => m.billingMethod === 'rubs')
  const submeters = meters.filter(m => m.billingMethod === 'submeter')
  const others = meters.filter(m => m.billingMethod === 'flat_rate' || m.billingMethod === 'master_bill_to_landlord')
  // S558: a unit is auto-excluded from a RUBS master's split when it has its OWN
  // same-utility submeter — derived from shared unit membership, no manual link.
  const unitHasSubmeter = (unitId: string, utilityType: string) =>
    meters.some(x => x.billingMethod === 'submeter' && x.utilityType === utilityType && (x.assignedUnitIds || []).includes(unitId))

  const del = useMutation((id: string) => apiDelete(`/utility/meters/${id}`),
    { onSuccess: onChanged, onError: (e: any) => toast.error(e?.response?.data?.error || e?.message || 'Delete failed') })
  const assign = useMutation(({ id, unitId }: any) => apiPost(`/utility/meters/${id}/units`, { unitId }),
    { onSuccess: onChanged, onError: (e: any) => toast.error(e?.response?.data?.error || e?.message || 'Could not assign unit') })
  const unassign = useMutation(({ id, unitId }: any) => apiDelete(`/utility/meters/${id}/units/${unitId}`), { onSuccess: onChanged })
  const setBroken = useMutation(({ id, broken }: any) => apiPatch(`/utility/meters/${id}`, { outOfService: broken }),
    { onSuccess: onChanged, onError: (e: any) => toast.error(e?.response?.data?.error || 'Could not update the meter') })

  function UnitAssigner({ m }: { m: any }) {
    const assigned: string[] = m.assignedUnitIds || []
    const available = units.filter(u => !assigned.includes(u.id))
    // A submeter measures exactly ONE unit — cap it at 1. Only RUBS masters
    // (the group that splits the pool) and flat-rate serve multiple units.
    const isSubmeter = m.billingMethod === 'submeter'
    const isMaster = m.billingMethod === 'rubs'
    const label = isMaster
      ? 'Units this master serves — submetered ones bill directly & are excluded; the rest split the remainder'
      : isSubmeter ? 'Metered unit' : 'Units billed'
    const canAddMore = available.length > 0 && !(isSubmeter && assigned.length >= 1)
    return (
      <div style={{ marginTop: 8 }}>
        <div style={{ fontSize: '.68rem', color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 4 }}>
          {label}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          {assigned.map(uid => {
            const excluded = isMaster && unitHasSubmeter(uid, m.utilityType)
            return (
              <span key={uid} title={excluded ? 'Has its own submeter — billed directly and subtracted from the pool' : undefined}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '.74rem', background: 'var(--bg-2)', border: `1px solid ${excluded ? 'var(--gold)' : 'var(--border-0)'}`, borderRadius: 6, padding: '2px 6px' }}>
                {unitLabel(uid)}
                {isMaster && <span style={{ fontSize: '.6rem', color: excluded ? 'var(--gold)' : 'var(--text-3)' }}>{excluded ? '🔌 submetered' : 'splits'}</span>}
                <X size={11} style={{ cursor: 'pointer', color: 'var(--text-3)' }} onClick={() => unassign.mutate({ id: m.id, unitId: uid })} />
              </span>
            )
          })}
          {assigned.length === 0 && <span style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>none yet</span>}
          {canAddMore && (
            <select className="form-select" style={{ width: 'auto', fontSize: '.74rem', padding: '2px 6px' }} value="" onChange={e => { if (e.target.value) assign.mutate({ id: m.id, unitId: e.target.value }) }}>
              <option value="">{isSubmeter ? 'set unit…' : '+ add unit…'}</option>
              {available.map(u => <option key={u.id} value={u.id}>Unit {u.unitNumber}</option>)}
            </select>
          )}
        </div>
      </div>
    )
  }

  function MasterCard({ m }: { m: any }) {
    const served: string[] = m.assignedUnitIds || []
    const submeteredCount = served.filter(uid => unitHasSubmeter(uid, m.utilityType)).length
    return (
      <div className="card" style={{ padding: 14, marginBottom: 12, borderColor: 'var(--gold)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: '1.15rem' }}>{UTILITY_ICONS[m.utilityType]}</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, color: 'var(--text-0)' }}>{m.label}</div>
            <div style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>{methodLabel(m)}</div>
          </div>
          <button className="btn btn-ghost btn-sm" style={{ color: 'var(--red)' }} onClick={() => appConfirm(`Delete master "${m.label}"? Its submeters stay.`, { danger: true, confirmLabel: 'Delete' }).then(ok => { if (ok) del.mutate(m.id) })}><Trash2 size={13} /></button>
        </div>
        <UnitAssigner m={m} />
        {served.length > 0 && (
          <div style={{ marginTop: 8, fontSize: '.68rem', color: 'var(--text-3)' }}>
            {submeteredCount > 0
              ? `${submeteredCount} of ${served.length} units are submetered → billed directly and subtracted; the other ${served.length - submeteredCount} split the remaining pool by ${RUBS_ALLOC_LABEL[m.rubsAllocationMethod] || m.rubsAllocationMethod}.`
              : `No submetered units here — the whole reading splits by ${RUBS_ALLOC_LABEL[m.rubsAllocationMethod] || m.rubsAllocationMethod}. To exclude a unit, give it its own submeter.`}
          </div>
        )}
      </div>
    )
  }

  function PlainCard({ m }: { m: any }) {
    return (
      <div className="card" style={{ padding: 14, marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: '1.1rem' }}>{UTILITY_ICONS[m.utilityType]}</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, color: 'var(--text-0)', display:'flex', alignItems:'center', gap:6 }}>
              {m.label}
              {m.outOfService && <span className="badge badge-amber" style={{ fontSize:'.62rem' }}>out of service</span>}
            </div>
            <div style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>
              {methodLabel(m)}
              {m.outOfService && <> · billed from the lowest comparable spot until repaired</>}
            </div>
          </div>
          {m.billingMethod === 'submeter' && (
            <button className="btn btn-ghost btn-sm" title={m.outOfService ? 'Mark repaired' : 'Mark broken — bills from comparable spots'}
              onClick={() => setBroken.mutate({ id: m.id, broken: !m.outOfService })}>
              <Wrench size={13} style={{ color: m.outOfService ? 'var(--gold)' : 'var(--text-3)' }} />
            </button>
          )}
          <button className="btn btn-ghost btn-sm" style={{ color: 'var(--red)' }} onClick={() => appConfirm(`Delete meter "${m.label}"?`, { danger: true, confirmLabel: 'Delete' }).then(ok => { if (ok) del.mutate(m.id) })}><Trash2 size={13} /></button>
        </div>
        {m.billingMethod !== 'master_bill_to_landlord' && <UnitAssigner m={m} />}
      </div>
    )
  }

  return (
    <div style={{ marginBottom: 28 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <h2 style={{ fontSize: '.95rem', margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}><Gauge size={16} /> Meter Setup</h2>
        <button className="btn btn-primary btn-sm" onClick={() => setShowAdd(true)}><Plus size={14} /> Add meter</button>
      </div>
      {meters.length === 0 && (
        <div className="card" style={{ padding: 20, fontSize: '.82rem', color: 'var(--text-3)' }}>
          No meters yet. Add a RUBS master for a shared meter, submeters for individually-metered units, or a flat-rate meter (e.g. trash).
        </div>
      )}
      {masters.map(m => <MasterCard key={m.id} m={m} />)}
      {submeters.map(m => <PlainCard key={m.id} m={m} />)}
      {others.map(m => <PlainCard key={m.id} m={m} />)}
      {showAdd && <AddMeterModal propertyId={propertyId} onClose={() => setShowAdd(false)} onCreated={onChanged} />}
    </div>
  )
}

function AddMeterModal({ propertyId, onClose, onCreated }: { propertyId: string; onClose: () => void; onCreated: () => void }) {
  const [utilityType, setUtilityType] = useState('water')
  const [label, setLabel] = useState('')
  const [method, setMethod] = useState('rubs')
  const [rate, setRate] = useState('')
  const [baseFee, setBaseFee] = useState('')
  const [alloc, setAlloc] = useState('occupant_count')
  const [error, setError] = useState('')

  const create = useMutation(
    () => apiPost('/utility/meters', {
      propertyId, utilityType, label,
      billingMethod: method,
      ratePerUnit: method === 'flat_rate' || method === 'master_bill_to_landlord' ? null : (rate === '' ? null : Number(rate)),
      baseFee: method === 'flat_rate' ? Number(baseFee || 0) : Number(baseFee || 0),
      rubsAllocationMethod: method === 'rubs' ? alloc : null,
    }),
    { onSuccess: () => { onCreated(); onClose() }, onError: (e: any) => setError(e?.response?.data?.error || e?.message || 'Could not create meter') }
  )
  const canSave = !!label && (method !== 'flat_rate' || Number(baseFee) > 0)

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 420 }} onClick={e => e.stopPropagation()}>
        <div className="modal-title">Add meter</div>
        <div style={{ marginBottom: 10 }}>
          <label style={lbl}>Utility</label>
          <select className="form-select" value={utilityType} onChange={e => setUtilityType(e.target.value)} style={{ width: '100%' }}>
            {['water', 'gas', 'electric', 'sewer', 'trash'].map(u => <option key={u} value={u}>{UTILITY_ICONS[u]} {u[0].toUpperCase() + u.slice(1)}</option>)}
          </select>
        </div>
        <div style={{ marginBottom: 10 }}>
          <label style={lbl}>Label</label>
          <input className="input" value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. Master C — city water" style={{ width: '100%' }} autoFocus />
        </div>
        <div style={{ marginBottom: 10 }}>
          <label style={lbl}>Billing method</label>
          <select className="form-select" value={method} onChange={e => setMethod(e.target.value)} style={{ width: '100%' }}>
            <option value="rubs">RUBS master — split a shared meter across units</option>
            <option value="submeter">Submeter — one metered unit</option>
            <option value="flat_rate">Flat rate — fixed charge per unit (e.g. trash)</option>
            <option value="master_bill_to_landlord">Master — landlord pays, no tenant bills</option>
          </select>
        </div>
        {method === 'rubs' && (
          <div style={{ marginBottom: 10 }}>
            <label style={lbl}>Split method</label>
            <select className="form-select" value={alloc} onChange={e => setAlloc(e.target.value)} style={{ width: '100%' }}>
              <option value="occupant_count">By occupancy (headcount)</option>
              <option value="equal_split">Equal split</option>
              <option value="sqft">By square footage</option>
              <option value="bedrooms">By bedrooms</option>
            </select>
          </div>
        )}
        {(method === 'rubs' || method === 'submeter') && (
          <div style={{ marginBottom: 10 }}>
            <label style={lbl}>Rate per {UTILITY_UNITS[utilityType] || 'unit'} ($)</label>
            <input className="input" type="number" step="0.001" value={rate} onChange={e => setRate(e.target.value)} placeholder="e.g. 0.01" style={{ width: '100%' }} />
          </div>
        )}
        {method === 'flat_rate' && (
          <div style={{ marginBottom: 10 }}>
            <label style={lbl}>Flat amount per unit ($/cycle) *</label>
            <input className="input" type="number" step="0.01" value={baseFee} onChange={e => setBaseFee(e.target.value)} placeholder="e.g. 20.00" style={{ width: '100%' }} />
          </div>
        )}
        {(method === 'rubs' || method === 'submeter') && (
          <div style={{ marginBottom: 10 }}>
            <label style={lbl}>Base fee per bill ($, optional)</label>
            <input className="input" type="number" step="0.01" value={baseFee} onChange={e => setBaseFee(e.target.value)} placeholder="0.00" style={{ width: '100%' }} />
          </div>
        )}
        {error && <div style={{ color: 'var(--red)', fontSize: '.8rem', marginBottom: 8 }}>{error}</div>}
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!canSave || create.isLoading} onClick={() => create.mutate()}>{create.isLoading ? 'Adding…' : 'Add meter'}</button>
        </div>
      </div>
    </div>
  )
}
