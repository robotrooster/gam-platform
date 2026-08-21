import { useState, useEffect, useMemo, CSSProperties } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { useSearchParams } from 'react-router-dom'
import { apiGet, apiPost, apiPut, apiDelete, apiPatch } from '../lib/api'
import { UTILITY_TYPE_LABEL, type UtilityType, METER_READING_DEFAULT_DIGITS, PROPANE_SPLIT_FOUR_MIN_GALLONS, PROPANE_SPLIT_MIN_GALLONS, propaneSplitOptions, METER_READ_MANUAL_REASONS, METER_READ_REASON_LABEL } from '@gam/shared'
import { ClipboardList, Receipt, ChevronRight, CheckCircle2, AlertTriangle, Gauge, Plus, Trash2, X, ClipboardCheck, Wrench, Pencil } from 'lucide-react'
import { toast, appConfirm } from '../components/dialogs'
import { usePerms } from '../lib/permissions'

const fmt = (n: any) => n != null ? `$${Number(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}` : '—'

// S613 (Nic): "We have twenty five point zero zero zero zero zero. We have five
// decimal places for something that can never be charged more than down to the
// penny."
//
// Right about the display — the column is numeric(12,5) and its raw value was
// going straight into the input, so a $25 trash charge read back as 25.00000.
// Number() drops the dead zeros: 25.00000 → "25", 0.21000 → "0.21".
//
// The STORED precision stays, and this is the reason: a per-usage rate genuinely
// lives below a cent. Water is commonly sold per THOUSAND gallons — $3.50/1,000
// is $0.0035 a gallon, which rounds to $0.00 at two decimals and would bill
// nothing at all. Precision in the RATE is not precision in the CHARGE; every
// bill is still rounded to the penny when it is written. A FLAT charge is
// different — it IS the charge — so that one is held to two decimals.
const trimRate = (v: any) => v == null || v === '' ? '' : String(Number(v))
/** A flat charge is the amount itself, so it can't be finer than a penny. */
const FLAT_RATE_UTILITIES = ['trash']
// Meter reads are odometer values — display with leading zeros at the
// meter's own digit width (a cycled-over 6-digit meter reads 000133).
// S613: `digits` is NULL on anything with no dial (trash, any flat rate). Those
// have no readings to print, but the fallback keeps a null from becoming NaN
// padding if one ever reaches here.
const fmtRead = (v: any, digits: any) => String(Math.trunc(Number(v))).padStart(Number(digits) || METER_READING_DEFAULT_DIGITS, '0')
const lbl: CSSProperties = { fontSize:'.75rem', color:'var(--text-3)', marginBottom:4, display:'block' }

const UTILITY_ICONS: Record<string, string> = { water:'💧', gas:'🔥', electric:'⚡', sewer:'🚰', trash:'🗑️', propane:'🛢️' }
const UTILITY_UNITS: Record<string, string> = { water:'gal', gas:'therms', electric:'kWh', sewer:'gal', trash:'', propane:'gal' }
const BILL_STATUS: Record<string, string> = { unbilled:'badge-muted', billed:'badge-amber', paid:'badge-green', waived:'badge-muted' }

const monthLabel = (cycle: any) => new Date(String(cycle).slice(0, 10) + 'T00:00:00Z')
  .toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })

// The end-of-month reading-run workflow (Nic's design; replaced the S531
// manual record-reading/generate-bills surface). A run opens on the last
// business day of each month and prompts the manager; the guided walk
// steps meter-to-meter, auto-calculates usage for leased spots, and the
// charges ride each tenant's next monthly invoice automatically.
// S605 (Nic, DIRECTIVE): property-scoped screens belong INSIDE a property, not
// as top-level nav. "A sub tab in the actual property... that way we see, like,
// the amenities tab, inventory would be scoped to a specific property."
//
// `embeddedPropertyId` renders this as a tab of PropertyDetailPage: the property
// is already chosen by the page around it, so the page title and the property
// picker are suppressed. Standalone use is unchanged.
//
// The picker was also only rendered when a landlord had MORE THAN ONE property —
// so a single-property landlord saw no scoping control at all and the page read
// as global. Inside a property hub that ambiguity disappears entirely.
export function UtilityMetersPage({ embeddedPropertyId }: { embeddedPropertyId?: string } = {}) {
  const qc = useQueryClient()
  const { can } = usePerms()
  // Front desk (utility.read_meters) can take reads; only the landlord
  // (properties.edit) sees prior/entered values, meter setup, and reviews.
  const canReview = can('properties.edit')
  const canRead = canReview || can('utility.read_meters')
  const [searchParams] = useSearchParams()
  const { data: properties = [] } = useQuery<any[]>('properties', () => apiGet('/properties'))
  const [propertyId, setPropertyId] = useState(() => embeddedPropertyId || searchParams.get('propertyId') || '')
  useEffect(() => { if (embeddedPropertyId) setPropertyId(embeddedPropertyId) }, [embeddedPropertyId])
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
            {!embeddedPropertyId && <>
              <h1 className="page-title">Utilities</h1>
              <p className="page-subtitle">Monthly meter reading runs and per-unit utility billing</p>
            </>}
          </div>
          {!embeddedPropertyId && (properties as any[]).length > 1 && (
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

          {/* S605: rates sit ABOVE meter setup — the price is the first thing
              you decide for a property, and every meter below bills at it. */}
          <PropertyRatesCard propertyId={propertyId} />

          {/* ── METER SETUP (S558: masters, submeters, RUBS groups, flat-rate) ── */}
          {/* Meter setup is LANDLORD-only (broken toggle, rates, links). */}
          {canReview && (
            <>
              <RecoveryCard propertyId={propertyId} />
              <MeterConfigSection propertyId={propertyId} meters={meters as any[]} units={units as any[]} onChanged={invalidate} />
            </>
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
  // S607: a bill_amount master needs a second number — the provider's dollar
  // charge for the cycle — kept beside the usage entry, keyed the same way.
  const [bills, setBills] = useState<Record<string, string>>({})
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
  // S607: a master on the bill total needs a usage figure ONLY when submetered
  // units sit on its line — that carve-out is measured in usage. Otherwise the
  // bill alone is enough, which is what an electric bill with peak/off-peak
  // tiers, demand charges and riders leaves you with.
  const usageOptional = (m: any) => m.rubsBasis === 'bill_amount' && !m.hasSubmeteredUnits
  const readOk = (m: any, v: string) => m.billingMethod === 'submeter'
    ? new RegExp(`^\\d{${m.digits}}$`).test(v)
    : usageOptional(m) ? (v === '' || /^[0-9]+$/.test(v)) : /^[0-9]+$/.test(v)
  const billOk = (m: any, v: string) => m.rubsBasis !== 'bill_amount' || /^\d+(\.\d{1,2})?$/.test(v)
  const stepComplete = !!step && step.meters.every(m =>
    savedIds.has(m.meterId) || (readOk(m, values[m.meterId] ?? '') && billOk(m, bills[m.meterId] ?? '')))

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
          { readingValue: Number(values[m.meterId] || 0),
            ...(m.rubsBasis === 'bill_amount' ? { billAmount: Number(bills[m.meterId]) } : {}) })
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
                    maxLength={m.billingMethod === 'submeter' ? m.digits : 12}
                    autoComplete="off"
                    autoFocus={i === 0}
                    placeholder={m.billingMethod === 'submeter' ? `${m.digits}-digit read, e.g. ${'0'.repeat(Math.max(0, m.digits - 3))}133` : `usage total (up to ${m.digits} digits)`}
                    disabled={savedIds.has(m.meterId)}
                    value={savedIds.has(m.meterId) ? '✓ recorded' : (values[m.meterId] ?? '')}
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
                  {m.rubsBasis === 'bill_amount' && !savedIds.has(m.meterId) && (
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
        <button className="btn btn-primary btn-sm" onClick={()=>setFillModal(true)}>Record Delivery</button>
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
        <PropaneDeliveryModal propertyId={propertyId} units={units} allowSplits={allowSplits}
          splitMin={splitMin} splitFourMin={splitFourMin}
          onClose={()=>{ setFillModal(false); qc.invalidateQueries(['propane-fills', propertyId]); onChanged() }}/>
      )}
    </>
  )
}

/**
 * S609 (Nic): record a propane DELIVERY — one master bill, several tanks.
 *
 * "There is a master bill that comes to the property, and we assign out each
 *  station that had their fill. It's already on the bill in terms of gallons, so
 *  we just need to be able to type in this many gallons at this unit or some
 *  units that don't have it, don't get those gallons because they don't have
 *  propane. It's a per time fill... it may be once every three months."
 *
 * So: the price once (it is what the invoice charged), then a gallons box beside
 * each unit. Blank means that tank wasn't filled — there is nothing to opt out
 * of. The running totals are there to check against the invoice before saving,
 * because a mistyped tank becomes a tenant's bill.
 */
function PropaneDeliveryModal({ propertyId, units, allowSplits, splitMin, splitFourMin, onClose }: {
  propertyId: string; units: any[]; allowSplits: boolean
  splitMin: number; splitFourMin: number; onClose: () => void
}) {
  // S609 (Nic): the property's propane price per gallon — "we need a way to also
  // set the rate for the propane at the property level, that way when we're
  // putting in gallons it can calculate the bill for that tenant correctly."
  // Prefilled here so a delivery is usually just gallons; still editable,
  // because the truck's price genuinely moves between deliveries.
  const { data: propertyRates = [] } = useQuery<any[]>(
    ['utility-property-rates', propertyId], () => apiGet(`/utility/property-rates?propertyId=${propertyId}`))
  const propaneRate = (propertyRates as any[]).find((r: any) => r.utilityType === 'propane')?.ratePerUnit
  const [ppg, setPpg] = useState('')
  useEffect(() => {
    if (ppg === '' && propaneRate != null) setPpg(String(Number(propaneRate)))
  }, [propaneRate])
  const [gallonsBy, setGallonsBy] = useState<Record<string, string>>({})
  // S609: what each unit still owes on EARLIER fills. Recording a new fill
  // ACCELERATES that balance — every unbilled installment becomes due at once
  // (the truck doesn't coordinate with the office). The old one-tank form warned
  // about this and the first version of the delivery form lost it; on a delivery
  // it matters more, not less, because one submit can accelerate several tenants
  // at the same time.
  const { data: fills = [] } = useQuery<any[]>(
    ['propane-fills', propertyId], () => apiGet(`/propane/fills?propertyId=${propertyId}`))
  const priorBalanceFor = (unitId: string) => (fills as any[])
    .filter((f: any) => f.unitId === unitId)
    .reduce((sum: number, f: any) => sum + Number(f.balanceRemaining || 0), 0)
  const [installments, setInstallments] = useState(1)
  const [clientKey] = useState(() => crypto.randomUUID())
  const { data: taxRates = [] } = useQuery<any[]>(
    ['utility-tax-rates', propertyId], () => apiGet(`/utility/tax-rates?propertyId=${propertyId}`))
  const taxPct = Number((taxRates as any[]).find((r: any) => r.utilityType === 'propane')?.taxRatePct || 0)

  // S613: a tank is a fact about the space, recorded on the unit alongside its
  // submeters. Only those spaces can take a delivery.
  const tankUnits = (units as any[]).filter((u: any) => u.hasPropaneTank)
  const lines = Object.entries(gallonsBy)
    .map(([unitId, g]) => ({ unitId, gallons: Number(g) || 0 }))
    .filter(l => l.gallons > 0)
  const totalGallons = lines.reduce((s, l) => s + l.gallons, 0)
  const subtotal = Math.round(totalGallons * (Number(ppg) || 0) * 100) / 100
  const tax = Math.round(subtotal * taxPct) / 100
  const total = Math.round((subtotal + tax) * 100) / 100

  // Splits are gated by the SMALLEST tank on the delivery — every fill on it is
  // recorded with the same installment count, so the tightest line governs.
  const smallest = lines.length ? Math.min(...lines.map(l => l.gallons)) : 0
  const splitOpts = allowSplits && lines.length ? propaneSplitOptions(smallest, splitMin, splitFourMin) : [1]
  useEffect(() => { if (!splitOpts.includes(installments)) setInstallments(1) }, [totalGallons, allowSplits, smallest])

  const mut = useMutation(
    () => apiPost('/propane/deliveries', {
      propertyId, pricePerGallon: Number(ppg), installments, lines, clientKey,
    }),
    { onSuccess: onClose,
      onError: (e: any) => toast.error(e?.response?.data?.error || 'Could not record this delivery') }
  )

  const canSave = lines.length > 0 && Number(ppg) > 0 && !mut.isLoading

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 520 }} onClick={e => e.stopPropagation()}>
        <div className="modal-title">Record propane delivery</div>
        <div style={{ fontSize: '.74rem', color: 'var(--text-3)', marginBottom: 12, lineHeight: 1.5 }}>
          Straight off the delivery invoice: the price once, then the gallons that went into each
          tank. Leave a unit blank if it wasn&apos;t filled.
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={lbl}>Price per gallon (from the invoice)</label>
          <input className="input" type="number" step="0.001" value={ppg} autoFocus
            onChange={e => setPpg(e.target.value)} placeholder="e.g. 3.25" style={{ width: 140 }} />
          {propaneRate != null && (
            <div style={{ fontSize: '.68rem', color: 'var(--text-3)', marginTop: 4 }}>
              Prefilled from this property&apos;s propane rate. Change it if this delivery was priced differently.
            </div>
          )}
        </div>

        {/* S613 (Nic): ONLY the spaces that actually have a tank. "You need to
            link which units even have tanks to be filled so that you can record
            the event in the first place." This listed every unit at the property
            and asked for gallons on each — thirty rows at Oak Park for the few
            with a tank, and no way to tell which were which. */}
        <label style={lbl}>Gallons per tank</label>
        {tankUnits.length === 0 ? (
          <div style={{ marginTop: 4, padding: '12px 14px', borderRadius: 8, background: 'var(--bg-2)',
                        fontSize: '.78rem', color: 'var(--text-3)', lineHeight: 1.6 }}>
            No spaces are marked as having a propane tank yet. Open a unit and tick
            <strong> Propane tank</strong> under Utilities — that is what puts it on this form.
          </div>
        ) : (
        <div style={{ maxHeight: 280, overflowY: 'auto', border: '1px solid var(--border-1)', borderRadius: 8, marginTop: 4 }}>
          {tankUnits.map((u: any) => (
            <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px',
                                     borderBottom: '1px solid var(--border-1)' }}>
              <span style={{ fontSize: '.82rem', color: 'var(--text-1)', flex: 1 }}>Unit {u.unitNumber}</span>
              {priorBalanceFor(u.id) > 0 && (
                <span title="Recording a fill here makes this whole balance due immediately"
                  style={{ fontSize: '.68rem', color: 'var(--amber)', whiteSpace: 'nowrap' }}>
                  {fmt(priorBalanceFor(u.id))} owing
                </span>
              )}
              <input className="input" type="number" step="0.1" min={0}
                value={gallonsBy[u.id] ?? ''}
                onChange={e => setGallonsBy(prev => ({ ...prev, [u.id]: e.target.value }))}
                placeholder="—" style={{ width: 90, textAlign: 'right' }} />
              <span style={{ fontSize: '.7rem', color: 'var(--text-3)', width: 26 }}>gal</span>
            </div>
          ))}
        </div>
        )}

        {allowSplits && splitOpts.length > 1 && (
          <div style={{ marginTop: 12 }}>
            <label style={lbl}>Split each tank&apos;s charge into</label>
            <div style={{ display: 'flex', gap: 8 }}>
              {splitOpts.map(n => (
                <button key={n} className={`btn btn-sm ${installments === n ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => setInstallments(n)}>
                  {n === 1 ? 'One payment' : `${n} payments`}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Check against the invoice before it becomes somebody's bill. */}
        <div style={{ marginTop: 14, padding: 10, borderRadius: 8, background: 'var(--bg-2)', fontSize: '.8rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-2)' }}>
            <span>{lines.length} tank{lines.length === 1 ? '' : 's'} · {totalGallons.toLocaleString()} gal</span>
            <span className="mono">{fmt(subtotal)}</span>
          </div>
          {taxPct > 0 && (
            <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-3)', marginTop: 3, fontSize: '.74rem' }}>
              <span>Tax ({taxPct}%)</span><span className="mono">{fmt(tax)}</span>
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, color: 'var(--text-0)', marginTop: 6, paddingTop: 6, borderTop: '1px solid var(--border-1)' }}>
            <span>Delivery total</span><span className="mono">{fmt(total)}</span>
          </div>
          <div style={{ fontSize: '.68rem', color: 'var(--text-3)', marginTop: 6, lineHeight: 1.45 }}>
            Should match the invoice. Each tenant is billed their own tank&apos;s gallons at this price.
          </div>
        </div>

        {(() => {
          const accelerating = lines.filter(l => priorBalanceFor(l.unitId) > 0)
          const owed = accelerating.reduce((s, l) => s + priorBalanceFor(l.unitId), 0)
          return accelerating.length > 0 ? (
            <div className="alert a-warn" style={{ marginTop: 10, fontSize: '.76rem', lineHeight: 1.5 }}>
              {accelerating.length} of these tenant{accelerating.length === 1 ? '' : 's'} still owe
              {accelerating.length === 1 ? 's' : ''} {fmt(owed)} from an earlier fill. Recording this
              delivery makes those balances due immediately, on top of the new charge.
            </div>
          ) : null
        })()}

        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!canSave} onClick={() => mut.mutate()}>
            {mut.isLoading ? 'Recording…' : `Record ${lines.length || ''} fill${lines.length === 1 ? '' : 's'}`.replace('  ', ' ')}
          </button>
        </div>
      </div>
    </div>
  )
}

/* S609: PropaneFillModal (one tank at a time) removed — the delivery flow
   supersedes it. A single tank is just a delivery with one line, and keeping
   both would be two screens recording the same money a different way. */

function PropertyRatesCard({ propertyId }: { propertyId: string }) {
  const qc = useQueryClient()
  const { data: rates = [] } = useQuery<any[]>(
    ['property-utility-rates', propertyId], () => apiGet(`/utility/property-rates?propertyId=${propertyId}`))
  const [draft, setDraft] = useState<Record<string, { rate: string; sewer: string }>>({})
  // S609 (Nic): PROPANE has a property price per gallon — "we need a way to also
  // set the rate for the propane at the property level, that way when we're
  // putting in gallons it can calculate the bill for that tenant correctly."
  // It has no meter (fills are events, not readings), so it appears here in
  // Rates and nowhere in the meter list.
  const TYPES = ['electric', 'water', 'gas', 'trash', 'propane']
  const row = (t: string) => (rates as any[]).find((r: any) => r.utilityType === t)

  const mut = useMutation(
    (p: any) => apiPost('/utility/property-rates', { propertyId, ...p }),
    { onSuccess: () => { qc.invalidateQueries(['property-utility-rates', propertyId]); toast('Rate saved.') },
      onError: (e: any) => toast.error(e?.response?.data?.error || 'Could not save the rate') },
  )

  return (
    <>
      <h2 style={{ fontSize: '.95rem', margin: '24px 0 12px' }}>Utility rates</h2>
      <div className="card" style={{ padding: 14, marginBottom: 10 }}>
        <div style={{ fontSize: '.76rem', color: 'var(--text-3)', marginBottom: 12, lineHeight: 1.5 }}>
          What this property charges per unit of usage. <strong>The same rate applies to every
          tenant here</strong> — meters bill at this price regardless of how they were set up.
          Changing it affects future bills only; bills already issued keep the rate they were charged at.
        </div>
        {TYPES.map(t => {
          const cur = row(t)
          const d = draft[t] ?? {
            rate: trimRate(cur?.ratePerUnit),
            sewer: trimRate(cur?.sewerRatePerUnit),
          }
          const pennyOnly = FLAT_RATE_UTILITIES.includes(t)
          const set = (k: 'rate' | 'sewer', v: string) =>
            setDraft(p => ({ ...p, [t]: { ...d, [k]: v } }))
          return (
            <div key={t} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '8px 0',
              borderBottom: '1px solid var(--border-0)', flexWrap: 'wrap' }}>
              <span style={{ minWidth: 92, fontSize: '.82rem', fontWeight: 600 }}>
                {UTILITY_ICONS[t]} {UTILITY_TYPE_LABEL[t as UtilityType] ?? t}
              </span>
              {/* S613: a flat charge steps by the penny, because it IS the
                  charge. A usage rate steps finer — water sold per thousand
                  gallons lands at $0.0035, which two decimals would round to
                  nothing. */}
              <input className="input input-sm" type="number" step={pennyOnly ? '0.01' : '0.00001'} value={d.rate}
                onChange={e => set('rate', e.target.value)}
                placeholder={pennyOnly ? '$ per unit / cycle' : `$ per ${UTILITY_UNITS[t] || 'unit'}`}
                style={{ width: 150 }} />
              {t === 'propane' && (
                <span style={{ fontSize: '.68rem', color: 'var(--text-3)' }}>
                  prefills a delivery; editable per delivery
                </span>
              )}
              {t === 'trash' && (
                <span style={{ fontSize: '.68rem', color: 'var(--text-3)' }}>
                  the flat charge every unit on a trash meter pays
                </span>
              )}
              {t === 'water' && (
                <input className="input input-sm" type="number" step="0.00001" value={d.sewer}
                  onChange={e => set('sewer', e.target.value)}
                  placeholder="sewer $/gal (optional)" style={{ width: 175 }} />
              )}
              <button className="btn btn-primary btn-sm" disabled={mut.isLoading}
                onClick={() => mut.mutate({
                  utilityType: t,
                  ratePerUnit: d.rate === '' ? null : Number(d.rate),
                  baseFee: 0,
                  ...(t === 'water' ? { sewerRatePerUnit: d.sewer === '' ? null : Number(d.sewer) } : {}),
                })}>Save</button>
              {cur?.ratePerUnit != null && (
                <span style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>
                  currently {pennyOnly ? fmt(cur.ratePerUnit) : `$${trimRate(cur.ratePerUnit)}`}{pennyOnly ? '' : `/${UTILITY_UNITS[t] || 'unit'}`}
                </span>
              )}
            </div>
          )
        })}
      </div>
    </>
  )
}

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
const RUBS_ALLOC_LABEL: Record<string,string> = { occupant_count:'by occupancy (headcount)', sqft:'by sq ft', bedrooms:'by bedrooms', rented_spaces:'equal split across rented units', fixture_count:'by plumbing fixtures', unit_type_weight:'by unit type weight', hybrid:'blended split' }
const RUBS_BASIS_LABEL: Record<string,string> = { usage_rate:'priced at your rate', bill_amount:'divides the utility bill' }
function rateLabel(m: any) { return m.ratePerUnit != null ? `${fmt(m.ratePerUnit)}/${UTILITY_UNITS[m.utilityType] || 'unit'}` : 'no rate set' }
function methodLabel(m: any): string {
  if (m.billingMethod === 'rubs') return `RUBS master · ${RUBS_ALLOC_LABEL[m.rubsAllocationMethod] || m.rubsAllocationMethod} · ${m.rubsBasis === 'bill_amount' ? RUBS_BASIS_LABEL['bill_amount'] : rateLabel(m)}`
  if (m.billingMethod === 'submeter') return `Submeter · ${rateLabel(m)}`
  // S609: the amount lives on the property rate now, not the meter, so the card
  // names the rule instead of printing a figure the meter does not hold.
  if (m.billingMethod === 'flat_rate') return `Flat rate · property ${m.utilityType} rate, same for every unit on it`
  if (m.billingMethod === 'master_bill_to_landlord') return 'Master meter · landlord pays'
  return m.billingMethod
}

/**
 * S613 (Nic): "Over a whole year when there's fifty thousand dollars in
 * utilities and there's twelve thousand maybe not billed back to people, we
 * wanna see that... that way we can measure how much utility wasn't billed back."
 *
 * Spent is what the property recorded paying for utilities; recovered is what it
 * billed out. The gap is the number. The owner-occupied slice is called out
 * because it is recorded as it happens — the rest of the gap (common areas, a
 * nightly stay with power in the rate, a vacancy, a lease that never passed it
 * through) is left unattributed rather than guessed at.
 *
 * A utility with no expense recorded shows a dash, not a shortfall: with nothing
 * on the spent side there is nothing to subtract from, and printing the whole
 * recovery as "not recovered" would be a lie in the landlord's own report.
 */
function RecoveryCard({ propertyId }: { propertyId: string }) {
  const thisYear = new Date().getFullYear()
  const [year, setYear] = useState(thisYear)
  const { data } = useQuery<any>(
    ['utility-recovery', propertyId, year],
    () => apiGet(`/utility/recovery?propertyId=${propertyId}&from=${year}-01-01&to=${year}-12-31`),
    { enabled: !!propertyId },
  )
  const lines: any[] = data?.lines ?? []
  const t = data?.totals
  if (!t || (t.spent === 0 && t.recovered === 0)) return null

  return (
    <div style={{ marginBottom: 28 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <h2 style={{ fontSize: '.95rem', margin: 0 }}>What the utilities cost, and what came back</h2>
        <select className="form-select" style={{ width: 'auto', fontSize: '.78rem', padding: '2px 8px' }}
          value={year} onChange={e => setYear(Number(e.target.value))}>
          {[thisYear, thisYear - 1, thisYear - 2].map(y => <option key={y} value={y}>{y}</option>)}
        </select>
      </div>
      <div className="card" style={{ padding: 14 }}>
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: '.68rem', color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.05em' }}>Spent</div>
            <div className="mono" style={{ fontSize: '1.05rem', fontWeight: 700 }}>{fmt(t.spent)}</div>
          </div>
          <div>
            <div style={{ fontSize: '.68rem', color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.05em' }}>Billed back</div>
            <div className="mono" style={{ fontSize: '1.05rem', fontWeight: 700, color: 'var(--green)' }}>{fmt(t.recovered)}</div>
          </div>
          <div>
            <div style={{ fontSize: '.68rem', color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.05em' }}>Not recovered</div>
            <div className="mono" style={{ fontSize: '1.05rem', fontWeight: 700, color: t.notRecovered > 0 ? 'var(--gold)' : 'var(--text-1)' }}>
              {fmt(t.notRecovered)}
            </div>
          </div>
          {t.ownerOccupied > 0 && (
            <div>
              <div style={{ fontSize: '.68rem', color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.05em' }}>Of that, your own units</div>
              <div className="mono" style={{ fontSize: '1.05rem', fontWeight: 700 }}>{fmt(t.ownerOccupied)}</div>
            </div>
          )}
        </div>
        <table style={{ width: '100%', fontSize: '.78rem', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ color: 'var(--text-3)', fontSize: '.68rem', textTransform: 'uppercase', letterSpacing: '.05em' }}>
              <th style={{ textAlign: 'left', padding: '4px 0' }}>Utility</th>
              <th style={{ textAlign: 'right' }}>Spent</th>
              <th style={{ textAlign: 'right' }}>Billed back</th>
              <th style={{ textAlign: 'right' }}>Not recovered</th>
              <th style={{ textAlign: 'right' }}>Your units</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l: any) => (
              <tr key={l.utilityType} style={{ borderTop: '1px solid var(--border-0)' }}>
                <td style={{ padding: '5px 0' }}>
                  {UTILITY_ICONS[l.utilityType] || ''}{' '}
                  {l.utilityType === 'unspecified' ? 'Unspecified' : (UTILITY_TYPE_LABEL[l.utilityType as UtilityType] ?? l.utilityType)}
                </td>
                <td className="mono" style={{ textAlign: 'right' }}>{l.spent ? fmt(l.spent) : '—'}</td>
                <td className="mono" style={{ textAlign: 'right', color: 'var(--green)' }}>{l.recovered ? fmt(l.recovered) : '—'}</td>
                <td className="mono" style={{ textAlign: 'right', color: (l.notRecovered ?? 0) > 0 ? 'var(--gold)' : undefined }}>
                  {l.notRecovered == null ? '—' : fmt(l.notRecovered)}
                </td>
                <td className="mono" style={{ textAlign: 'right' }}>{l.ownerOccupied ? fmt(l.ownerOccupied) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ fontSize: '.68rem', color: 'var(--text-3)', marginTop: 10, lineHeight: 1.6 }}>
          &ldquo;Spent&rdquo; is what you recorded under <strong>Expenses → Utilities</strong> for this property; tag each
          bill with its utility and these lines split out. A dash means no bill was recorded, so there
          is nothing to compare against. What isn&apos;t your own units is common areas, stays with
          utilities in the rate, vacancies, and anything a lease doesn&apos;t pass through.
        </div>
      </div>
    </div>
  )
}

/**
 * S613 (Nic): "It needs to be toggled the same way as trash plus the fill
 * amount. If I just click on the propane — ten, eleven, twelve, fifteen,
 * sixteen, eighteen, all on propane — they're all toggled on, and so they all
 * can get delivery amounts individually. You just skipped the step of adding
 * them to this card."
 *
 * He is right and it was a plain omission. A tank could be marked on the unit
 * page one space at a time and nowhere else, so standing propane up across a
 * park meant opening every space in turn — while trash, which is the same
 * question, got a checklist. That a tank isn't a meter is an implementation
 * detail; it is no reason to make the landlord do it the slow way.
 *
 * Ticking is free — nothing saves until Save — and the ticked spaces are exactly
 * the ones Record Delivery then offers, each with its own gallons.
 */
function PropaneTanksCard({ propertyId, units, onChanged }: {
  propertyId: string; units: any[]; onChanged: () => void
}) {
  const live = (units as any[]).filter((u: any) => u.propertyId === propertyId && !u.retiredAt)
  const [picked, setPicked] = useState<Set<string> | null>(null)
  const current = picked ?? new Set(live.filter((u: any) => u.hasPropaneTank).map((u: any) => u.id))
  const dirty = picked !== null
  const toggle = (id: string) => {
    const next = new Set(current)
    next.has(id) ? next.delete(id) : next.add(id)
    setPicked(next)
  }
  const save = useMutation(
    () => apiPut('/propane/tanks', { propertyId, unitIds: Array.from(current) }),
    {
      onSuccess: (r: any) => {
        setPicked(null)
        onChanged()
        toast(`${r?.changed ?? 0} space${r?.changed === 1 ? '' : 's'} changed — ${r?.withTank ?? 0} now on Record Delivery.`)
      },
      onError: (e: any) => toast.error(e?.response?.data?.error || 'Could not save that'),
    },
  )
  const removing = live.filter((u: any) => u.hasPropaneTank && !current.has(u.id))

  return (
    <div className="card" style={{ padding: 14 }}>
      <div style={{ fontWeight: 700, color: 'var(--text-0)', marginBottom: 2 }}>Spaces with a propane tank</div>
      <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginBottom: 10, lineHeight: 1.6 }}>
        Tick every space that has a tank. Those are the ones <strong>Record Delivery</strong> offers, each
        with its own gallons. A tank isn&apos;t a meter — nobody reads it — so propane bills off the
        gallons delivered, not a monthly reading.
      </div>
      {live.length === 0 ? (
        <div style={{ fontSize: '.78rem', color: 'var(--text-3)' }}>No units at this property yet.</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 4,
                      maxHeight: 300, overflowY: 'auto' }}>
          {live.map((u: any) => {
            const on = current.has(u.id)
            return (
              <label key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '4px 6px',
                                          borderRadius: 6, background: on ? 'rgba(201,162,39,.08)' : 'transparent',
                                          cursor: 'pointer', fontSize: '.78rem' }}>
                <input type="checkbox" checked={on} onChange={() => toggle(u.id)} />
                {u.unitNumber}
              </label>
            )
          })}
        </div>
      )}
      {dirty && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          <button className="btn btn-primary btn-sm" disabled={save.isLoading}
            onClick={() => {
              // Unticking a space that HAS a tank is a removal, and removals are
              // never casual here — money already owed on delivered propane keeps
              // billing either way, which is worth saying before it looks like a
              // way to cancel a charge.
              if (removing.length === 0) return save.mutate()
              appConfirm(
                `Take the tank off ${removing.length} space${removing.length === 1 ? '' : 's'} ` +
                `(${removing.map((u: any) => u.unitNumber).join(', ')})?\n\n` +
                `They stop appearing on Record Delivery. Anything still owed on propane already ` +
                `delivered keeps billing — this doesn't cancel that.`,
                { danger: true, confirmLabel: 'Save' },
              ).then(ok => { if (ok) save.mutate() })
            }}>
            {save.isLoading ? 'Saving…' : 'Save'}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => setPicked(null)}>Cancel</button>
          <span style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>
            {current.size} space{current.size === 1 ? '' : 's'} with a tank
          </span>
        </div>
      )}
    </div>
  )
}

function MeterConfigSection({ propertyId, meters, units, onChanged }: {
  propertyId: string; meters: any[]; units: any[]; onChanged: () => void
}) {
  const [showAdd, setShowAdd] = useState(false)
  // S609: the meter currently being edited (null = none open).
  const [editMeter, setEditMeter] = useState<any>(null)
  // S609: the meter whose units are being picked (null = picker closed).
  const [pickFor, setPickFor] = useState<any>(null)
  const unitLabel = (id: string) => { const u = units.find(x => x.id === id); return u ? `Unit ${u.unitNumber}` : id.slice(0, 8) }
  // S613: the flat-charge amount lives on the PROPERTY rate, so a card that says
  // "flat $25/mo" has to read it from there — the meter row deliberately has no
  // amount (anti-discrimination, S609).
  const { data: propertyRates = [] } = useQuery<any[]>(
    ['utility-property-rates', propertyId], () => apiGet(`/utility/property-rates?propertyId=${propertyId}`))

  // S613: which utility panel is open. Null = the summary of all of them.
  const [openType, setOpenType] = useState<string | null>(null)

  // A propane TANK is not a meter (units.has_propane_tank), so propane can be
  // fully set up at a property with no propane meter at all. Counted here so the
  // utility still gets a card rather than looking like it doesn't exist.
  const tankUnitCount = (units as any[]).filter((u: any) => u.hasPropaneTank).length

  // S613 (Nic): "I don't see propane in the meter setup area. It should be right
  // there with electric, water and trash the same... Propane isn't necessarily
  // metered, it's filled — but the principle is the same, and we select which
  // units have that meter even though it's not an actual meter. We metered the
  // usage in a different way for that utility."
  //
  // The cards were built from what EXISTS, so propane only appeared once a space
  // already had a tank — and the card is the place you go to mark the tanks. The
  // same chicken-and-egg I had already been caught on twice: gating the only
  // door behind the thing it opens.
  //
  // This page's job is SETUP, so it lists every utility you can set up, whether
  // or not you have yet. (That is the opposite of the unit page, which shows only
  // what a unit HAS — there, an unused utility really is clutter.) Sewer is not
  // offered on its own because it has no independent setup: it rides the water
  // meter and bills on the water line. It still gets a card if one exists.
  const typeCards = (() => {
    const OFFERED = ['electric', 'water', 'gas', 'trash', 'propane']
    const types = Array.from(new Set([...OFFERED, ...meters.map(m => m.utilityType)]))
    const order = ['electric', 'water', 'sewer', 'gas', 'trash', 'propane']
    types.sort((a, b) => order.indexOf(a) - order.indexOf(b))
    return types.map(type => {
      const mine = meters.filter(m => m.utilityType === type)
      const subs = mine.filter(m => m.billingMethod === 'submeter')
      const rubs = mine.filter(m => m.billingMethod === 'rubs')
      const flat = mine.filter(m => m.billingMethod === 'flat_rate')
      const landlord = mine.filter(m => m.billingMethod === 'master_bill_to_landlord')
      const rate = (propertyRates as any[]).find((r: any) => r.utilityType === type)

      const bits: string[] = []
      if (subs.length) bits.push(`${subs.length} space${subs.length === 1 ? '' : 's'} submetered`)
      for (const m of rubs) {
        const n = (m.assignedUnitIds || []).length
        bits.push(`master → ${n} space${n === 1 ? '' : 's'}`)
      }
      for (const m of flat) {
        const n = (m.assignedUnitIds || []).length
        bits.push(`flat ${rate ? fmt(rate.ratePerUnit) : '—'}/mo · ${n} space${n === 1 ? '' : 's'}`)
      }
      if (landlord.length) bits.push('landlord pays — not billed back')
      if (type === 'propane' && tankUnitCount) bits.push(`tanks on ${tankUnitCount} space${tankUnitCount === 1 ? '' : 's'}`)
      if (rate?.ratePerUnit != null && subs.length) bits.push(`${fmt(rate.ratePerUnit)}/unit`)

      const problems: string[] = []
      const noRead = mine.filter(m => m.hasBaseline === false).length
      if (noRead) problems.push(`${noRead} need${noRead === 1 ? 's' : ''} an opening read`)
      const blocked = new Set<string>()
      for (const m of mine) for (const u of (m.unitsNotBilling || [])) blocked.add(u)
      if (blocked.size) problems.push(`${blocked.size} lease${blocked.size === 1 ? '' : 's'} won't bill it`)

      const configured = mine.length > 0 || (type === 'propane' && tankUnitCount > 0)
      return {
        type, configured, problems: configured ? problems : [],
        summary: bits.join(' · ') || (
          type === 'propane' ? 'not set up — tick the spaces that have a tank'
          : type === 'trash' ? 'not set up — a flat monthly charge, or split from the hauler’s bill'
          : 'not set up'),
      }
    }).sort((a, b) => Number(b.configured) - Number(a.configured))
  })()
  // S558: a unit is auto-excluded from a RUBS master's split when it has its OWN
  // same-utility submeter — derived from shared unit membership, no manual link.
  const unitHasSubmeter = (unitId: string, utilityType: string) =>
    meters.some(x => x.billingMethod === 'submeter' && x.utilityType === utilityType && (x.assignedUnitIds || []).includes(unitId))

  // S609 (Nic): which OTHER meter has already claimed this unit for this utility,
  // if any. Mirrors the double-billing rule the API enforces: a unit may be on one
  // submeter AND one master for a utility (the metered-exclusion pairing), but
  // never two of the same KIND — that unit would be billed twice.
  //
  // The picker was offering units already on another master and letting the
  // server refuse them one by one. Nic: "it shouldn't even show those as
  // selectable on the other meter." Right — the screen should know the rule, not
  // discover it. Returns the blocking meter so the reason can be shown rather
  // than the unit just quietly vanishing.
  const conflictingMeterFor = (unitId: string, meter: any) =>
    meters.find(x =>
      x.id !== meter.id &&
      x.utilityType === meter.utilityType &&
      (x.billingMethod === 'submeter') === (meter.billingMethod === 'submeter') &&
      (x.assignedUnitIds || []).includes(unitId)) || null

  const del = useMutation((id: string) => apiDelete(`/utility/meters/${id}`),
    { onSuccess: onChanged, onError: (e: any) => toast.error(e?.response?.data?.error || e?.message || 'Delete failed') })
  const assign = useMutation(({ id, unitId }: any) => apiPost(`/utility/meters/${id}/units`, { unitId }),
    { onSuccess: onChanged, onError: (e: any) => toast.error(e?.response?.data?.error || e?.message || 'Could not assign unit') })
  const unassign = useMutation(({ id, unitId }: any) => apiDelete(`/utility/meters/${id}/units/${unitId}`), { onSuccess: onChanged })
  const setBroken = useMutation(({ id, broken }: any) => apiPatch(`/utility/meters/${id}`, { outOfService: broken }),
    { onSuccess: onChanged, onError: (e: any) => toast.error(e?.response?.data?.error || 'Could not update the meter') })
  // S613 (Nic): a meter can be configured perfectly and bill nothing, because a
  // unit bills a utility only where its LEASE passes it through. Assigning
  // twenty-seven units to a brand-new trash charge hits that on twenty-seven
  // leases at once, silently. This records the pass-through for all of them.
  const billBack = useMutation((id: string) => apiPost(`/utility/meters/${id}/bill-back`, {}), {
    onSuccess: (r: any) => {
      onChanged()
      toast(`${r?.data?.leasesUpdated ?? 0} lease${r?.data?.leasesUpdated === 1 ? '' : 's'} updated — it starts on the next invoice.`)
    },
    onError: (e: any) => toast.error(e?.response?.data?.error || 'Could not record that'),
  })
  function BillBackNotice({ m }: { m: any }) {
    const blocked: string[] = m.unitsNotBilling || []
    if (blocked.length === 0) return null
    return (
      <div style={{ marginTop: 8, padding: '8px 10px', borderRadius: 7, fontSize: '.72rem', lineHeight: 1.6,
                    color: 'var(--amber)', background: 'rgba(245,158,11,.07)', border: '1px solid rgba(245,158,11,.25)' }}>
        ⚠ {blocked.length} unit{blocked.length === 1 ? '' : 's'} on this
        ({blocked.map(unitLabel).join(', ')}) {blocked.length === 1 ? 'has a lease that' : 'have leases that'}
        &nbsp;don&apos;t mention {m.utilityType}, so {blocked.length === 1 ? 'it bills' : 'they bill'} nothing.
        <button className="btn btn-secondary btn-sm" style={{ marginLeft: 8, padding: '1px 8px', fontSize: '.68rem' }}
          disabled={billBack.isLoading}
          onClick={() => appConfirm(
            `Bill ${m.utilityType} back to ${blocked.length} tenant${blocked.length === 1 ? '' : 's'}?\n\n` +
            `Their leases don't cover it, so this is an addendum — you should have their written ` +
            `agreement, the same as adding it on paper. GAM records that you turned it on and when.\n\n` +
            `It starts on the next invoice. Nothing already sent changes.`,
            { confirmLabel: 'Bill it back' },
          ).then(ok => { if (ok) billBack.mutate(m.id) })}>
          Bill it back
        </button>
      </div>
    )
  }

  function UnitAssigner({ m }: { m: any }) {
    const assigned: string[] = m.assignedUnitIds || []
    // S609 (Nic): only what can actually be picked. The SUBMETER dropdown had the
    // same flaw as the master picker — with eight mobile-home submeters already
    // set up, adding a ninth listed every unit the other eight had taken, and the
    // server refused whichever you chose. Same rule as the picker: a unit already
    // on another meter of this KIND for this utility would be billed twice.
    const available = units
      .filter(u => !assigned.includes(u.id))
      .filter(u => !conflictingMeterFor(u.id, m))
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
          {/* S609 (Nic): a submeter takes exactly one unit, so the dropdown is
              still the quickest thing for it. A MASTER can serve dozens — Oak
              Park's water master serves 27 — and picking them one at a time
              meant the control jumped to the end of the chip list after every
              save, so the button was never where the mouse was. Masters and
              flat-rate meters get a checkbox picker instead. */}
          {canAddMore && (isSubmeter ? (
            <select className="form-select" style={{ width: 'auto', fontSize: '.74rem', padding: '2px 6px' }} value="" onChange={e => { if (e.target.value) assign.mutate({ id: m.id, unitId: e.target.value }) }}>
              <option value="">set unit…</option>
              {available.map(u => <option key={u.id} value={u.id}>Unit {u.unitNumber}</option>)}
            </select>
          ) : (
            <button className="btn btn-ghost btn-sm" style={{ fontSize: '.74rem', padding: '2px 8px' }}
              onClick={() => setPickFor(m)}>
              + add units…
            </button>
          ))}
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
          {/* S609 (Nic): a meter used to be uneditable once created — a typo in
              the label meant deleting a master and losing its unit assignments. */}
          <button className="btn btn-ghost btn-sm" title="Edit this meter" onClick={() => setEditMeter(m)}>
            <Pencil size={13} style={{ color: 'var(--text-3)' }} />
          </button>
          <button className="btn btn-ghost btn-sm" style={{ color: 'var(--red)' }} onClick={() => appConfirm(`Delete master "${m.label}"? Its submeters stay.`, { danger: true, confirmLabel: 'Delete' }).then(ok => { if (ok) del.mutate(m.id) })}><Trash2 size={13} /></button>
        </div>
        <UnitAssigner m={m} />
        <BillBackNotice m={m} />
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

  // S605 (Nic): the warning has to be ACTIONABLE where it appears. A landlord
  // told "this won't bill" with no way to fix it on the spot will carry on and
  // lose the cycle anyway. Backdating matters — the opening read must predate
  // the reads it enables, so the date is editable and defaults to the 1st of
  // the current month rather than today.
  function BaselineFixer({ m }: { m: any }) {
    const [open, setOpen] = useState(false)
    const [value, setValue] = useState('')
    const [date, setDate] = useState(() => new Date().toISOString().slice(0, 8) + '01')
    const [err, setErr] = useState('')
    const save = useMutation(
      () => apiPost(`/utility/meters/${m.id}/readings`, {
        readingValue: Number(value), readingDate: date,
        billingCycleMonth: date.slice(0, 7) + '-01', reason: 'baseline',
      }),
      { onSuccess: () => { setOpen(false); onChanged() },
        onError: (e: any) => setErr(e?.response?.data?.error || 'Could not save the opening read') },
    )
    return (
      <div style={{ marginTop: 6 }}>
        <div style={{ fontSize: '.72rem', color: 'var(--red)', lineHeight: 1.5 }}>
          Will not bill — usage is the difference between two reads and this meter has none yet.
        </div>
        {!open ? (
          <button className="btn btn-primary btn-sm" style={{ marginTop: 6 }} onClick={() => setOpen(true)}>
            <Plus size={13} /> Add opening read
          </button>
        ) : (
          <div style={{ marginTop: 6 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <input className="input input-sm" type="number" value={value} autoFocus
                onChange={e => setValue(e.target.value)} placeholder={`${m.digits}-digit read`} style={{ width: 150 }} />
              <input className="input input-sm" type="date" value={date}
                onChange={e => setDate(e.target.value)} style={{ width: 150 }} />
              <button className="btn btn-primary btn-sm" disabled={value === '' || save.isLoading}
                onClick={() => { setErr(''); save.mutate() }}>
                {save.isLoading ? 'Saving…' : 'Save'}
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>Cancel</button>
            </div>
            <div style={{ fontSize: '.68rem', color: 'var(--text-3)', marginTop: 4 }}>
              Date it when the meter was actually read — it must come before the reads you want to bill.
            </div>
            {err && <div style={{ color: 'var(--red)', fontSize: '.7rem', marginTop: 4 }}>{err}</div>}
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
              {/* S605 (Nic): the failure this exists to stop is a SILENT one —
                  a submeter with no opening read bills nothing and says nothing
                  until the cycle has already closed. */}
              {m.hasBaseline === false && (
                <span className="badge badge-red" style={{ fontSize:'.62rem' }}>no opening read</span>
              )}
            </div>
            <div style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>
              {methodLabel(m)}
              {m.outOfService && <> · billed from the lowest comparable spot until repaired</>}
            </div>
            {m.hasBaseline === false && <BaselineFixer m={m} />}
          </div>
          {m.billingMethod === 'submeter' && (
            <button className="btn btn-ghost btn-sm" title={m.outOfService ? 'Mark repaired' : 'Mark broken — bills from comparable spots'}
              onClick={() => setBroken.mutate({ id: m.id, broken: !m.outOfService })}>
              <Wrench size={13} style={{ color: m.outOfService ? 'var(--gold)' : 'var(--text-3)' }} />
            </button>
          )}
          <button className="btn btn-ghost btn-sm" title="Edit this meter" onClick={() => setEditMeter(m)}>
            <Pencil size={13} style={{ color: 'var(--text-3)' }} />
          </button>
          <button className="btn btn-ghost btn-sm" style={{ color: 'var(--red)' }} onClick={() => appConfirm(`Delete meter "${m.label}"?`, { danger: true, confirmLabel: 'Delete' }).then(ok => { if (ok) del.mutate(m.id) })}><Trash2 size={13} /></button>
        </div>
        {m.billingMethod !== 'master_bill_to_landlord' && <><UnitAssigner m={m} /><BillBackNotice m={m} /></>}
      </div>
    )
  }

  return (
    <div style={{ marginBottom: 28 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <h2 style={{ fontSize: '.95rem', margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}><Gauge size={16} /> Meter Setup</h2>
        <button className="btn btn-primary btn-sm" onClick={() => setShowAdd(true)}><Plus size={14} /> Add meter</button>
      </div>
      {/* S613 (Nic, DIRECTIVE): "We have all these submetered spots in a long
          line list... It's freaking a hundred meters long already with just
          nothing, and bigger parks would have even longer menus. That's not the
          way it needs to be. Consolidate. Have each meter setup have each type
          of thing, and then click into those to set all the units and the rates."

          One card per UTILITY, not per meter. Oak Park's 28 meters become four
          lines; a 200-space park becomes the same four. Each line answers what
          you would otherwise scroll to find — how this utility is billed here,
          how many spaces are on it, and whether anything about it is broken.

          The problem counts are the real gain. A submeter with no opening read
          bills nothing SILENTLY, and finding those meant reading every row. */}
      {openType === null ? (
        <div style={{ display: 'grid', gap: 10 }}>
          {typeCards.map(c => (
            <div key={c.type} className="card"
              style={{ padding: '12px 14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12,
                       opacity: c.configured ? 1 : .72 }}
              onClick={() => setOpenType(c.type)}>
              <span style={{ fontSize: '1.3rem', filter: c.configured ? undefined : 'grayscale(1)' }}>{UTILITY_ICONS[c.type]}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, color: c.configured ? 'var(--text-0)' : 'var(--text-2)' }}>
                  {UTILITY_TYPE_LABEL[c.type as UtilityType] ?? c.type}
                </div>
                <div style={{ fontSize: '.74rem', color: 'var(--text-3)' }}>{c.summary}</div>
              </div>
              {c.problems.map((p, i) => (
                <span key={i} className="badge badge-amber" style={{ fontSize: '.62rem', whiteSpace: 'nowrap' }}>⚠ {p}</span>
              ))}
              <ChevronRight size={16} style={{ color: 'var(--text-3)', flexShrink: 0 }} />
            </div>
          ))}
        </div>
      ) : (
        <div>
          <button className="btn btn-ghost btn-sm" style={{ marginBottom: 10 }} onClick={() => setOpenType(null)}>
            ← All utilities
          </button>
          {(() => {
            const forType = meters.filter(m => m.utilityType === openType)
            return (
              <>
                {forType.filter(m => m.billingMethod === 'rubs').map(m => <MasterCard key={m.id} m={m} />)}
                {forType.filter(m => m.billingMethod !== 'rubs').map(m => <PlainCard key={m.id} m={m} />)}
                {openType === 'propane' && <PropaneTanksCard propertyId={propertyId} units={units} onChanged={onChanged} />}
                {forType.length === 0 && openType !== 'propane' && (
                  <div className="card" style={{ padding: 16, fontSize: '.8rem', color: 'var(--text-3)', lineHeight: 1.6 }}>
                    Nothing set up for {(UTILITY_TYPE_LABEL[openType as UtilityType] ?? openType).toLowerCase()} yet.
                    {openType === 'trash'
                      ? <> Trash is usually a flat monthly charge — set its price under <strong>Utility rates</strong> below,
                          then add a flat-rate meter here and tick the spaces that have a can. It can also be split from
                          the hauler&apos;s bill as a shared master.</>
                      : <> Add a sub-meter for individually-metered spaces, or a shared master to split one bill
                          across several.</>}
                    <div style={{ marginTop: 10 }}>
                      <button className="btn btn-primary btn-sm" onClick={() => setShowAdd(true)}>
                        <Plus size={13} /> Set up {(UTILITY_TYPE_LABEL[openType as UtilityType] ?? openType).toLowerCase()}
                      </button>
                    </div>
                  </div>
                )}
              </>
            )
          })()}
        </div>
      )}
      {showAdd && <MeterModal propertyId={propertyId} onClose={() => setShowAdd(false)} onSaved={onChanged} />}
      {editMeter && <MeterModal propertyId={propertyId} meter={editMeter}
        onClose={() => setEditMeter(null)} onSaved={onChanged} />}
      {pickFor && <UnitPickerModal meter={pickFor} units={units}
        unitHasSubmeter={unitHasSubmeter} unitLabel={unitLabel}
        conflictingMeterFor={conflictingMeterFor}
        onClose={() => setPickFor(null)} onSaved={onChanged} />}
    </div>
  )
}

/**
 * S609 (Nic): pick MANY units for a meter at once.
 *
 * "Every time I click add a unit and then click the unit from that drop down, it
 * takes a second to load, and then it moves my button over, and it puts it at
 * the end of the list. So I have to keep moving the mouse to the new button spot
 * to click and add the next submeter. I want to have it where it opens a little
 * window, and I just can checkbox all the units that get applied to that master
 * meter."
 *
 * The old control was a dropdown sitting AFTER the assigned chips, so every save
 * grew the chip list and pushed the dropdown somewhere new. Twenty-seven units
 * meant twenty-seven round trips, each one chasing the control across the card.
 *
 * Nothing is saved until Add is pressed — ticking is free, so a mis-click costs
 * nothing and there is no per-unit wait.
 */
function UnitPickerModal({ meter, units, unitHasSubmeter, unitLabel, conflictingMeterFor, onClose, onSaved }: {
  meter: any; units: any[]
  unitHasSubmeter: (unitId: string, utilityType: string) => boolean
  unitLabel: (id: string) => string
  conflictingMeterFor: (unitId: string, meter: any) => any | null
  onClose: () => void; onSaved: () => void
}) {
  const assigned: string[] = meter.assignedUnitIds || []
  // ONLY the units that can actually be picked. S609 (Nic) — he overruled the
  // first version, which greyed out the taken ones and kept them in the list:
  //
  //   "The drop down is still too long. You have all the list in there of all
  //    the units just not selectable, and that looks like shit. It only needs to
  //    be the ones that are selectable... I don't want them to be grayed out
  //    because then I still have to scroll around looking for just the odd one
  //    or two."
  //
  // Right, and the earlier reasoning (a missing row raises "where did it go?")
  // only holds at three units. Oak Park's water master serves 27 — by the third
  // meter the list is almost entirely dead rows and the few live ones are
  // needles. The count of what was hidden is shown at the bottom instead, so
  // nothing is unexplained without costing a scroll.
  const takenElsewhere = units
    .filter(u => !assigned.includes(u.id))
    .filter(u => !!conflictingMeterFor(u.id, meter))
  const available = units
    .filter(u => !assigned.includes(u.id))
    .filter(u => !conflictingMeterFor(u.id, meter))
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [skipped, setSkipped] = useState<{ unitId: string; reason: string }[]>([])

  const toggle = (id: string) => setPicked(prev => {
    const next = new Set(prev)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })

  const add = useMutation(
    () => apiPost(`/utility/meters/${meter.id}/units`, { unitIds: [...picked] }),
    {
      onSuccess: (res: any) => {
        const result = res?.data ?? res
        const wasSkipped = result?.skipped ?? []
        onSaved()
        // A unit already on another meter of this utility is refused for a good
        // reason (it would be billed twice). Say WHICH and WHY rather than
        // silently adding fewer than were ticked.
        if (wasSkipped.length > 0) { setSkipped(wasSkipped); setPicked(new Set()) }
        else onClose()
      },
      onError: (e: any) => toast.error(e?.response?.data?.error || e?.message || 'Could not add units'),
    })

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 460 }} onClick={e => e.stopPropagation()}>
        <div className="modal-title">Add units to {meter.label}</div>

        {available.length === 0 ? (
          <div style={{ fontSize: '.82rem', color: 'var(--text-3)', padding: '8px 0', lineHeight: 1.5 }}>
            {takenElsewhere.length > 0
              ? `No units left to add — every other unit at this property is already on another ${meter.utilityType} meter.`
              : 'Every unit at this property is already on this meter.'}
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              <button className="btn btn-ghost btn-sm"
                onClick={() => setPicked(new Set(available.map(u => u.id)))}>Select all</button>
              {picked.size > 0 && (
                <button className="btn btn-ghost btn-sm" onClick={() => setPicked(new Set())}>Clear</button>
              )}
              <div style={{ marginLeft: 'auto', fontSize: '.74rem', color: 'var(--text-3)', alignSelf: 'center' }}>
                {picked.size} selected
              </div>
            </div>
            <div style={{ maxHeight: 320, overflowY: 'auto', border: '1px solid var(--border-1)', borderRadius: 8 }}>
              {available.map(u => {
                const sub = unitHasSubmeter(u.id, meter.utilityType)
                return (
                  <label key={u.id}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px',
                             borderBottom: '1px solid var(--border-1)', cursor: 'pointer', fontSize: '.82rem' }}>
                    <input type="checkbox" checked={picked.has(u.id)} onChange={() => toggle(u.id)} />
                    <span style={{ color: 'var(--text-1)' }}>Unit {u.unitNumber}</span>
                    {/* A unit with its own submeter still belongs on the master —
                        its usage is subtracted from the pool rather than split. */}
                    {sub && meter.billingMethod === 'rubs' && (
                      <span style={{ marginLeft: 'auto', fontSize: '.68rem', color: 'var(--gold)' }}>
                        🔌 submetered — billed directly, subtracted from the pool
                      </span>
                    )}
                  </label>
                )
              })}
            </div>
            {/* The hidden ones are accounted for in one line, so nothing is
                unexplained — without costing a scroll through dead rows. */}
            {takenElsewhere.length > 0 && (
              <div style={{ fontSize: '.68rem', color: 'var(--text-3)', marginTop: 6, lineHeight: 1.45 }}>
                {takenElsewhere.length} other unit{takenElsewhere.length === 1 ? ' is' : 's are'} already on
                another {meter.utilityType} meter and can&apos;t be added here — a unit on two would be billed twice.
              </div>
            )}
          </>
        )}

        {skipped.length > 0 && (
          <div className="alert a-warn" style={{ marginTop: 10, fontSize: '.76rem', lineHeight: 1.5 }}>
            <strong>{skipped.length} couldn&apos;t be added:</strong>
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              {skipped.map(sk => (
                <li key={sk.unitId}>{unitLabel(sk.unitId)} — {sk.reason}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>{skipped.length > 0 ? 'Done' : 'Cancel'}</button>
          <button className="btn btn-primary" disabled={picked.size === 0 || add.isLoading}
            onClick={() => add.mutate()}>
            {add.isLoading ? 'Adding…' : `Add ${picked.size || ''} unit${picked.size === 1 ? '' : 's'}`.trim()}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * S609 (Nic): add OR edit a meter — one form, both jobs.
 *
 * "I have no button to edit my first master meter that I added. I didn't label
 * it the way I wanted to, and there's no way to change it. I don't wanna have
 * to delete it and then add it again."
 *
 * He was right, and it was worse than a missing rename: a meter was FROZEN the
 * moment it was created. Label, base fee, split method, what the split is priced
 * from — all of it could only be set here, at creation, and afterwards the only
 * actions on a meter were "mark broken" and "delete". Deleting a master to fix a
 * typo would take its unit assignments with it.
 *
 * It also made a documented setup step impossible: the S608 handoff tells Nic to
 * switch Oak Park's master to the utility-bill basis and rented-units split.
 * There was no way to do it.
 *
 * ONE component for both so they cannot drift — a create form and an edit form
 * that disagree about what a field means is how a landlord ends up with a meter
 * configured differently depending on which screen touched it last.
 *
 * WHAT IS LOCKED, AND WHEN (Nic, DIRECTIVE — this replaced an earlier version
 * that froze the utility and billing method the moment a meter was created):
 *
 *   "Every feature needs to be editable on meters when there is no history.
 *    Only lock it once there's history, not once it's created. Somebody
 *    accidentally setting something up the wrong way needs to be able to change
 *    it so they don't have to redo potentially everything. That's gonna be a
 *    friction point during onboarding."
 *
 * He is right, and locking at creation was the wrong trigger. A meter that has
 * never been read and never billed has no history to protect — the only thing
 * the lock achieved was making a setup typo unfixable during the exact phase
 * where typos happen.
 *
 * So: EVERYTHING is editable until the meter has actually measured or billed
 * something. Once it has, the utility and billing method freeze — from then on
 * changing them would re-interpret readings already taken and bills already
 * sent, which is rewriting history rather than correcting a mistake.
 *
 * Unit assignments are NOT history. They survive an edit, which is the point:
 * fixing a wrong setup must not mean redoing the assignments as well.
 */
function MeterModal({ propertyId, meter, onClose, onSaved }: {
  propertyId: string; meter?: any; onClose: () => void; onSaved: () => void
}) {
  const editing = !!meter
  // S609: locked by USE, not by existence. A meter with no readings and no
  // bills is still fully editable. PATCH enforces the same rule server-side.
  const locked = editing && meter.hasHistory === true
  const [utilityType, setUtilityType] = useState(meter?.utilityType ?? 'water')
  const [label, setLabel] = useState(meter?.label ?? '')
  const [method, setMethod] = useState(meter?.billingMethod ?? 'rubs')
  const [basis, setBasis] = useState(meter?.rubsBasis ?? 'usage_rate')
  const [subRate, setSubRate] = useState(meter?.rubsSubmeterRate ?? 'property_rate')
  const [exclMode, setExclMode] = useState(meter?.rubsExclusionMode ?? 'usage')
  const [rate] = useState('')   // S605: rates are property policy; kept only for the create payload
  // S609: no longer editable — the flat-rate amount is the property rate, and a
  // RUBS master's own base fee is set with the property rates. Kept so the value
  // round-trips unchanged on an edit rather than being zeroed.
  const [baseFee] = useState(meter?.baseFee != null ? String(meter.baseFee) : '')
  const [alloc, setAlloc] = useState(meter?.rubsAllocationMethod ?? 'occupant_count')
  // S607: config for the bases that need one. Kept as discrete pieces of state
  // rather than a JSON box — a landlord should never be asked to type JSON.
  const [hybA, setHybA] = useState(meter?.rubsWeights?.primary ?? 'sqft')
  const [hybB, setHybB] = useState(meter?.rubsWeights?.secondary ?? 'occupant_count')
  const [hybPct, setHybPct] = useState(String(meter?.rubsWeights?.primaryPct ?? '50'))
  // "mobile_home:1.5, rv_spot:1" — rebuilt from the saved weights when editing.
  const [typeWeights, setTypeWeights] = useState(
    meter?.rubsAllocationMethod === 'unit_type_weight' && meter?.rubsWeights
      ? Object.entries(meter.rubsWeights).map(([k, v]) => `${k}:${v}`).join(', ')
      : '')
  // S605 (Nic): the OPENING READ. A submeter bills the difference between two
  // reads, so without a starting value its first cycle produces no bill and
  // says nothing about why. Asking here — the one moment it's obvious what the
  // number is for — is what stops a landlord discovering it after the cycle
  // closes. Defaults to today; backdate it to when the meter was actually read.
  const [baselineReading, setBaselineReading] = useState('')
  const [baselineDate, setBaselineDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [error, setError] = useState('')

  // The RUBS weight payload — identical for create and edit, built once.
  const weightsPayload = () =>
    method !== 'rubs' ? undefined
      : alloc === 'hybrid' ? { primary: hybA, secondary: hybB, primaryPct: Number(hybPct) || 50 }
      : alloc === 'unit_type_weight'
        ? Object.fromEntries(typeWeights.split(',').map(p => p.split(':'))
            .filter(p => p.length === 2 && p[0].trim())
            .map(p => [p[0].trim(), Number(p[1]) || 0]))
        : null

  const save = useMutation(
    () => editing
      // Edit sends ONLY what may change on a live meter. Utility and billing
      // method are absent on purpose — see the note on this component.
      ? apiPatch(`/utility/meters/${meter.id}`, {
          label,
          baseFee: Number(baseFee || 0),
          // S609: until a meter has readings or bills, the utility and billing
          // method are fixable too — sending them only when they are actually
          // editable keeps a locked meter's payload identical to before.
          ...(locked ? {} : { utilityType, billingMethod: method }),
          // The split method must match the billing method or the database
          // rejects the row: a RUBS master requires one, anything else must
          // have none. Sending null explicitly is what CLEARS it when someone
          // switches a master to a submeter.
          rubsAllocationMethod: method === 'rubs' ? alloc : null,
          ...(method === 'rubs' ? {
            rubsBasis: basis,
            rubsWeights: weightsPayload(),
            rubsSubmeterRate: subRate,
            rubsExclusionMode: exclMode,
          } : {}),
        })
      : apiPost('/utility/meters', {
      propertyId, utilityType, label,
      billingMethod: method,
      ratePerUnit: method === 'flat_rate' || method === 'master_bill_to_landlord' ? null : (rate === '' ? null : Number(rate)),
      baseFee: method === 'flat_rate' ? Number(baseFee || 0) : Number(baseFee || 0),
      rubsAllocationMethod: method === 'rubs' ? alloc : null,
      rubsBasis: method === 'rubs' ? basis : undefined,
      rubsWeights: weightsPayload() ?? undefined,
      rubsSubmeterRate: method === 'rubs' ? subRate : undefined,
      rubsExclusionMode: method === 'rubs' ? exclMode : undefined,
      ...(method === 'submeter' && baselineReading !== ''
        ? { baselineReading: Number(baselineReading), baselineDate }
        : {}),
    }),
    { onSuccess: () => { onSaved(); onClose() },
      onError: (e: any) => setError(e?.response?.data?.error || e?.message ||
        (editing ? 'Could not save this meter' : 'Could not create meter')) }
  )
  // S609: a flat-rate meter no longer carries its own amount — the property rate
  // is the amount — so there is nothing to require here beyond the label.
  const canSave = !!label
  // Opening reads are a create-time question only; an existing meter fixes a
  // missing one from its own card (BaselineFixer).
  const noBaseline = !editing && method === 'submeter' && baselineReading === ''

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 420 }} onClick={e => e.stopPropagation()}>
        <div className="modal-title">{editing ? 'Edit meter' : 'Add meter'}</div>
        {locked ? (
          // Fixed for a reason, and the reason is shown rather than left to be
          // discovered: this meter has already measured or billed something, so
          // these two decide how that existing history is read.
          <div style={{ marginBottom: 10, padding: 10, borderRadius: 8,
                        background: 'rgba(255,255,255,.03)', border: '1px solid var(--border-1)' }}>
            <div style={{ fontSize: '.8rem', color: 'var(--text-1)', fontWeight: 600 }}>
              {UTILITY_ICONS[utilityType]} {utilityType[0].toUpperCase() + utilityType.slice(1)}
              {' · '}
              {method === 'rubs' ? 'RUBS master'
                : method === 'submeter' ? 'Submeter'
                : method === 'flat_rate' ? 'Flat rate'
                : 'Master — landlord pays'}
            </div>
            <div style={{ marginTop: 4, fontSize: '.7rem', color: 'var(--text-3)', lineHeight: 1.45 }}>
              This meter has readings or bills against it, so the utility and billing method are
              now fixed — they decide how that history is read, and changing them would rewrite it
              rather than correct it. Everything below can still be changed at any time. If one of
              these two is genuinely wrong, add the meter you meant and retire this one.
            </div>
          </div>
        ) : (
        <div style={{ marginBottom: 10 }}>
          <label style={lbl}>Utility</label>
          <select className="form-select" value={utilityType} onChange={e => setUtilityType(e.target.value)} style={{ width: '100%' }}>
            {['water', 'gas', 'electric', 'sewer', 'trash'].map(u => <option key={u} value={u}>{UTILITY_ICONS[u]} {u[0].toUpperCase() + u.slice(1)}</option>)}
          </select>
        </div>
        )}
        <div style={{ marginBottom: 10 }}>
          <label style={lbl}>Label</label>
          <input className="input" value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. Master C — city water" style={{ width: '100%' }} autoFocus />
        </div>
        {!locked && (
        <div style={{ marginBottom: 10 }}>
          <label style={lbl}>Billing method</label>
          <select className="form-select" value={method} onChange={e => setMethod(e.target.value)} style={{ width: '100%' }}>
            <option value="rubs">RUBS master — split a shared meter across units</option>
            <option value="submeter">Submeter — one metered unit</option>
            <option value="flat_rate">Flat rate — fixed charge per unit (e.g. trash)</option>
            <option value="master_bill_to_landlord">Master — landlord pays, no tenant bills</option>
          </select>
        </div>
        )}
        {method === 'rubs' && (
          <>
            <div style={{ marginBottom: 10 }}>
              <label style={lbl}>Split method</label>
              <select className="form-select" value={alloc} onChange={e => setAlloc(e.target.value)} style={{ width: '100%' }}>
                <option value="occupant_count">By occupancy (headcount)</option>
                <option value="rented_spaces">Equal split across rented units</option>
                <option value="sqft">By square footage</option>
                <option value="bedrooms">By bedrooms</option>
                <option value="fixture_count">By plumbing fixture count</option>
                <option value="unit_type_weight">By unit type, your own weights</option>
                <option value="hybrid">Blend of two of the above</option>
              </select>
              {alloc === 'unit_type_weight' && (
                <div style={{ marginTop: 8 }}>
                  <label style={lbl}>Weight per unit type</label>
                  <input className="form-input" value={typeWeights} placeholder="mobile_home:1.5, rv_spot:1"
                    onChange={e => setTypeWeights(e.target.value)} />
                  <div style={{ marginTop: 4, fontSize: '.7rem', color: 'var(--text-3)' }}>
                    One pair per unit type. A type you leave out gets no share.
                  </div>
                </div>
              )}
              {alloc === 'hybrid' && (
                <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'flex-end' }}>
                  <div style={{ flex: 1 }}>
                    <label style={lbl}>Blend</label>
                    <select className="form-select" value={hybA} onChange={e => setHybA(e.target.value)}>
                      <option value="sqft">Square footage</option>
                      <option value="occupant_count">Occupancy</option>
                      <option value="bedrooms">Bedrooms</option>
                      <option value="rented_spaces">Equal across rented units</option>
                      <option value="fixture_count">Fixtures</option>
                    </select>
                  </div>
                  <div style={{ width: 78 }}>
                    <label style={lbl}>%</label>
                    <input className="form-input" value={hybPct} onChange={e => setHybPct(e.target.value)} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label style={lbl}>with</label>
                    <select className="form-select" value={hybB} onChange={e => setHybB(e.target.value)}>
                      <option value="occupant_count">Occupancy</option>
                      <option value="sqft">Square footage</option>
                      <option value="bedrooms">Bedrooms</option>
                      <option value="rented_spaces">Equal across rented units</option>
                      <option value="fixture_count">Fixtures</option>
                    </select>
                  </div>
                </div>
              )}
              <div style={{ marginTop: 4, fontSize: '.7rem', color: 'var(--text-3)', lineHeight: 1.45 }}>
                Rented-units-only leaves vacancies out of the split, so the whole bill lands on
                the units actually leased. Every-unit keeps vacancies in, and their share goes
                unbilled.
              </div>
            </div>
            {/* S607 (Nic, DIRECTIVE): the dollar-divide model is an OPTION, not a
                replacement. "We don't wanna restrict how people bill. We want the
                full functionality where they can operate in accordance with their
                state's laws, whatever that may be." usage_rate stays the default
                and every existing master keeps it. */}
            <div style={{ marginBottom: 10 }}>
              <label style={lbl}>What the split is priced from</label>
              <select className="form-select" value={basis} onChange={e => setBasis(e.target.value)} style={{ width: '100%' }}>
                <option value="usage_rate">Your rate — usage × the property rate, plus base fee</option>
                <option value="bill_amount">The utility bill — divide what you were actually charged</option>
              </select>
              <div style={{ marginTop: 4, fontSize: '.7rem', color: 'var(--text-3)', lineHeight: 1.45 }}>
                {basis === 'bill_amount'
                  ? 'Each cycle you enter the bill total alongside the usage. It blends into one rate, so the tenant sees a single line. Any base fee you set is added on top of the bill.'
                  : 'The property rate prices the usage. Anything the provider charges beyond that — service fees, taxes — stays with you.'}
              </div>
            </div>
            {/* S607 (Nic, DIRECTIVE): "we're going for flexibility here." How a
                master shares its line with submetered units is TWO independent
                choices, both defaulting to what the platform already did. */}
            {basis === 'bill_amount' && (
              <div style={{ marginBottom: 10, padding: 10, borderRadius: 8,
                            background: 'rgba(201,162,39,.05)', border: '1px solid rgba(201,162,39,.18)' }}>
                <div style={{ fontSize: '.72rem', color: 'var(--text-2)', marginBottom: 8, lineHeight: 1.45 }}>
                  Only applies where some units on this meter have their own submeter.
                </div>
                <label style={lbl}>Submetered units are billed at</label>
                <select className="form-select" value={subRate} onChange={e => setSubRate(e.target.value)} style={{ width: '100%', marginBottom: 8 }}>
                  <option value="property_rate">Your published rate</option>
                  <option value="blended">The blended rate off this bill</option>
                </select>
                <label style={lbl}>Take them out of the pool by</label>
                <select className="form-select" value={exclMode} onChange={e => setExclMode(e.target.value)} style={{ width: '100%' }}>
                  <option value="usage">Their usage — price whatever is left</option>
                  <option value="dollars">Their invoiced dollars — the bill closes exactly</option>
                </select>
                <div style={{ marginTop: 6, fontSize: '.7rem', color: 'var(--text-3)', lineHeight: 1.45 }}>
                  {subRate === 'property_rate' && exclMode === 'usage'
                    ? 'Heads up: with a published submeter rate, subtracting usage can leave the pool over or short of the bill. Subtracting dollars closes it.'
                    : exclMode === 'dollars'
                      ? 'Every dollar of the bill lands on somebody, whatever rate each submetered unit paid.'
                      : 'Everyone on the line ends up at the same cost per unit.'}
                </div>
              </div>
            )}
          </>
        )}
        {/* S605 (Nic, DIRECTIVE): "make utility rates set at the property level.
            Adding each unit is redundant and possible discrimination." The rate
            is no longer a per-meter field — it is property policy, set once for
            everyone, in the Rates panel above. Leaving the box here would invite
            a number that billing ignores. */}
        {(method === 'rubs' || method === 'submeter') && (
          <div style={{ marginBottom: 10, fontSize: '.72rem', color: 'var(--text-3)', lineHeight: 1.5 }}>
            The rate comes from this property's utility rates — every tenant pays the same
            price for the same utility. Set it in <strong>Rates</strong> at the top of this page.
          </div>
        )}
        {/* S605 (Nic): opening read — submeters only. RUBS and master-bill
            allocate off the property invoice and never read an odometer. */}
        {!editing && method === 'submeter' && (
          <div style={{ marginBottom: 10, padding: 10, borderRadius: 8, background: 'rgba(201,162,39,.06)', border: '1px solid rgba(201,162,39,.2)' }}>
            <label style={lbl}>Opening read (current meter face)</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input className="input" type="number" value={baselineReading}
                onChange={e => setBaselineReading(e.target.value)}
                placeholder={`${'0'.repeat(Math.max(0, 5))}0 — what it reads now`} style={{ flex: 2 }} />
              <input className="input" type="date" value={baselineDate}
                onChange={e => setBaselineDate(e.target.value)} style={{ flex: 1 }} />
            </div>
            <div style={{ fontSize: '.7rem', color: noBaseline ? 'var(--red)' : 'var(--text-3)', marginTop: 6, lineHeight: 1.5 }}>
              {noBaseline
                ? 'Without an opening read this meter will NOT bill its first cycle — there\'s nothing to measure usage against. You can add one later from the meter card, but it must be dated before the reads you want to bill.'
                : 'Usage is the difference between two reads, so the first bill needs a starting point. Backdate this to when the meter was actually read.'}
            </div>
          </div>
        )}
        {/* S609 (Nic, DIRECTIVE): a flat per-unit charge is NOT editable here.
            "It's a discrimination thing. If you're billing a flat rate per unit,
             it needs to not be editable. It needs to be set at the property level
             the same way late fees are... anybody that's opted into it
             automatically gets the flat twenty five dollars."
            An editable-per-meter amount is a way to bill two identical units two
            different amounts for the same service. The rate lives on the property
            (Rates, above); what stays per-unit is only WHETHER the unit is on the
            meter — a resident hauling their own trash is simply not assigned. */}
        {method === 'flat_rate' && (
          <div style={{ marginBottom: 10, padding: 10, borderRadius: 8,
                        background: 'rgba(201,162,39,.06)', border: '1px solid rgba(201,162,39,.2)' }}>
            <div style={{ fontSize: '.78rem', color: 'var(--text-1)', fontWeight: 600, marginBottom: 4 }}>
              The amount comes from this property&apos;s {utilityType} rate
            </div>
            <div style={{ fontSize: '.7rem', color: 'var(--text-3)', lineHeight: 1.5 }}>
              Every unit on this meter is billed the same amount, set once in <strong>Rates</strong> at
              the top of this page — so two identical units can never be charged differently for the
              same service. Choose which units are on it after you create the meter; anyone who opts
              out simply isn&apos;t assigned.
            </div>
          </div>
        )}
        {error && <div style={{ color: 'var(--red)', fontSize: '.8rem', marginBottom: 8 }}>{error}</div>}
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!canSave || save.isLoading} onClick={() => save.mutate()}>
            {save.isLoading ? (editing ? 'Saving…' : 'Adding…') : (editing ? 'Save changes' : 'Add meter')}
          </button>
        </div>
      </div>
    </div>
  )
}
