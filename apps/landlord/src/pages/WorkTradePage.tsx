import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { apiGet, apiPatch, apiPost } from '../lib/api'
import { ChevronDown, Plus, X } from 'lucide-react'
import { toast } from '../components/dialogs'

const STATUS_MAP: Record<string, string> = { active: 'badge-green', paused: 'badge-amber', ended: 'badge-muted' }
const DOC_STATUS_LABEL: Record<string, string> = { pending: 'Draft', draft: 'Draft', sent: 'Awaiting signature', in_progress: 'Awaiting signature', completed: 'On file', voided: 'Voided', execution_failed: 'Needs attention' }

// W-56 (Nic): targets are PER PERSON (edited inline on each agreement row
// below) — different rents and different work don't translate equally.
// This property value is only the DEFAULT applied to NEW agreements.
// One editable default per property:
function PropertyTargetRow({ propertyId, name }: { propertyId: string; name: string }) {
  const qc = useQueryClient()
  const { data } = useQuery<any>(['wt-prop-target', propertyId], () => apiGet(`/work-trade/property/${propertyId}/target`))
  const target = Number(data?.target ?? 80)
  const [value, setValue] = useState<string | null>(null)
  const shown = value ?? String(target)
  const save = useMutation(
    (t: number) => apiPatch(`/work-trade/property/${propertyId}/target`, { target: t }),
    { onSuccess: () => { qc.invalidateQueries(['wt-prop-target', propertyId]); setValue(null) } }
  )
  const dirty = value != null && Number(value) !== target && Number(value) > 0
  return (
    <div className="row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '8px 0' }}>
      <div><b>{name}</b></div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input type="number" min={1} value={shown} onChange={e => setValue(e.target.value)}
          style={{ width: 80, padding: '5px 8px', textAlign: 'right' }} className="input" />
        <span style={{ color: 'var(--text-3)', fontSize: '.8rem' }}>hrs / mo</span>
        <button className="btn btn-sm" disabled={!dirty || save.isLoading}
          onClick={() => save.mutate(Number(shown))}>
          {save.isLoading ? '…' : 'Save'}
        </button>
      </div>
    </div>
  )
}

export function WorkTradePage() {
  const [showNew, setShowNew] = useState(false)
  const { data: agreements = [], isLoading } = useQuery<any[]>('work-trade', () => apiGet('/work-trade'))
  // S576 (B-8): the landlord's own work-trade addendum forms (Form Type =
  // Work-Trade Addendum). Fetched once, passed to each row's addendum cell.
  const { data: addendumTemplates = [] } = useQuery<any[]>('wt-addendum-templates', () => apiGet('/esign/templates?purpose=work_trade_addendum'))

  const navigate = useNavigate()
  // Distinct properties for the new-agreement DEFAULT editor. a.target is
  // now the per-agreement value, so fetch nothing extra — the default
  // editor reads its own value lazily per property row.
  const properties = Array.from(
    new Map(agreements.map((a: any) => [a.propertyId, { id: a.propertyId, name: a.propertyName }])).values()
  )

  return (
    <div>
      <div className="page-header">
        <div><h1 className="page-title">Work Trade</h1><p className="page-subtitle">Rent-for-labor — hours buy a percent of the monthly bill</p></div>
        <button className="btn btn-primary" onClick={() => setShowNew(true)}>
          <Plus size={14} /> New agreement
        </button>
      </div>

      {showNew && <NewAgreementModal onClose={() => setShowNew(false)} />}

      {properties.length > 0 && (
        <div className="card" style={{ marginBottom: 16, padding: 16 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Default hours target for new agreements</div>
          <div style={{ color: 'var(--text-3)', fontSize: '.82rem', marginBottom: 8 }}>
            Each person's target is set on their row below — a full target month of approved hours covers 100% of THEIR invoice (rent + utilities + fees). This is just the starting value for new agreements.
          </div>
          {properties.map((p: any) => (
            <PropertyTargetRow key={p.id} propertyId={p.id} name={p.name} />
          ))}
        </div>
      )}

      <div className="card" style={{ padding: 0 }}>
        {isLoading ? <div style={{ padding: 32, color: 'var(--text-3)', textAlign: 'center' }}>Loading…</div> : (
          <table className="data-table">
            <thead><tr><th>Tenant</th><th>Unit</th><th>Property</th><th>This Month</th><th>Target</th><th>Grace</th><th>Covers</th><th>Pending</th><th>Start</th><th>Status</th><th>Addendum</th></tr></thead>
            <tbody>
              {agreements.length ? agreements.map((a: any) => (
                // W-56: the row pulls up the tenant's LEASE; the target cell
                // edits inline without triggering the row click.
                <tr key={a.id} style={{ cursor: a.leaseId ? 'pointer' : undefined }}
                  onClick={() => a.leaseId && navigate(`/leases?open=${a.leaseId}`)}
                  title={a.leaseId ? 'Open lease' : undefined}>
                  <td style={{ fontWeight: 500, color: a.leaseId ? 'var(--gold)' : undefined }}>{[a.tenantFirst, a.tenantLast].filter(Boolean).join(' ') || '—'}</td>
                  <td className="mono">{a.unitNumber || '—'}</td>
                  <td>{a.propertyName || '—'}</td>
                  <td className="mono">{Number(a.hoursThisMonth || 0).toFixed(1)} / {a.target} hrs</td>
                  <td onClick={e => e.stopPropagation()}><AgreementTargetCell agreementId={a.id} target={Number(a.target)} /></td>
                  <td onClick={e => e.stopPropagation()}><CarryForwardCell agreementId={a.id} months={Number(a.carryForwardMonths ?? 1)} /></td>
                  <td onClick={e => e.stopPropagation()}><AgreementCoversCell agreement={a} /></td>
                  <td className="mono">{Number(a.pendingCount) > 0
                    ? <span className="badge badge-amber">{a.pendingCount}</span>
                    : <span style={{ color: 'var(--text-3)' }}>0</span>}</td>
                  <td className="mono">{a.startDate ? new Date(a.startDate).toLocaleDateString() : '—'}</td>
                  <td><span className={`badge ${STATUS_MAP[a.status] || 'badge-muted'}`}>{a.status || '—'}</span></td>
                  <td onClick={e => e.stopPropagation()}><AddendumCell agreement={a} templates={addendumTemplates as any[]} /></td>
                </tr>
              )) : (
                <tr><td colSpan={10} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 32 }}>No work trade agreements yet.</td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

// S576 (B-8): send a work-trade addendum, or show the latest one's status.
// The agreement requires an active lease, so this rides the proven lease
// addendum path (POST /esign/documents/work-trade-addendum → then send). The
// landlord just picks their form; everything else resolves server-side.
function AddendumCell({ agreement, templates }: { agreement: any; templates: any[] }) {
  const qc = useQueryClient()
  const [picking, setPicking] = useState(false)
  const [templateId, setTemplateId] = useState('')
  const doc = agreement.addendumDoc

  const send = useMutation(
    async (tid: string) => {
      const res: any = await apiPost('/esign/documents/work-trade-addendum', { workTradeAgreementId: agreement.id, templateId: tid })
      const docId = res?.data?.id
      if (docId) await apiPost(`/esign/documents/${docId}/send`, {})
      return res
    },
    {
      onSuccess: () => { qc.invalidateQueries('work-trade'); qc.invalidateQueries('esign-documents'); setPicking(false); setTemplateId(''); toast('Work-trade addendum sent for signature.') },
      onError: (e: any) => toast.error(e?.response?.data?.error || e?.message || 'Could not send the addendum'),
    }
  )

  // Send an ALREADY-DRAFTED addendum (the renewal auto-carry leaves a `pending`
  // doc for the landlord to review + send).
  const sendExisting = useMutation(
    (docId: string) => apiPost(`/esign/documents/${docId}/send`, {}),
    {
      onSuccess: () => { qc.invalidateQueries('work-trade'); qc.invalidateQueries('esign-documents'); toast('Work-trade addendum sent for signature.') },
      onError: (e: any) => toast.error(e?.response?.data?.error || e?.message || 'Could not send the addendum'),
    }
  )

  // Auto-drafted (pending, unsent) addendum → landlord reviews + sends it.
  if (doc && doc.status === 'pending') {
    return (
      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
        <Link to="/esign" style={{ fontSize: '.72rem', color: 'var(--text-3)' }} title={doc.title || 'Open in GoldSign to review'}>Draft</Link>
        <button className="btn btn-primary btn-sm" disabled={sendExisting.isLoading} onClick={() => sendExisting.mutate(doc.id)}>
          {sendExisting.isLoading ? '…' : 'Review & send'}
        </button>
      </span>
    )
  }

  // A live (non-voided) addendum already exists → show its status.
  if (doc && doc.status !== 'voided') {
    return (
      <span className={`badge ${doc.status === 'completed' ? 'badge-green' : 'badge-amber'}`} title={doc.title || ''}>
        {DOC_STATUS_LABEL[doc.status] || doc.status}
      </span>
    )
  }

  // Only an active agreement (→ active lease) can send an addendum.
  if (agreement.status !== 'active') return <span style={{ color: 'var(--text-3)', fontSize: '.75rem' }}>—</span>

  if (templates.length === 0) {
    return <Link to="/esign" style={{ fontSize: '.72rem', color: 'var(--gold)', fontWeight: 600 }} title="Create a Work-Trade Addendum form: GoldSign → Templates → New Template → Form Type = Work-Trade Addendum">Add a form</Link>
  }

  if (picking && templates.length > 1) {
    return (
      <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
        <select className="form-input" style={{ width: 'auto', fontSize: '.72rem' }} value={templateId} onChange={e => setTemplateId(e.target.value)}>
          <option value="">Pick form…</option>
          {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <button className="btn btn-primary btn-sm" disabled={!templateId || send.isLoading} onClick={() => send.mutate(templateId)}>{send.isLoading ? '…' : 'Send'}</button>
      </span>
    )
  }

  return (
    <button className="btn btn-primary btn-sm" disabled={send.isLoading}
      onClick={() => { if (templates.length === 1) send.mutate(templates[0].id); else setPicking(true) }}>
      {send.isLoading ? 'Sending…' : 'Send addendum'}
    </button>
  )
}

// S613 (Nic): what this agreement actually trades for.
//
//   "If people are on a work trade agreement, those things might not be included
//    at some properties... they did fifty percent of the work for the rent and
//    the electric, and it bills them fifty percent of the electric, but propane
//    is excluded, so they get a hundred percent of the propane bill."
//
// PER AGREEMENT, beside the hours target, for the reason Nic gave for the target
// itself: "I have different agreements with different people here... some people
// do less work than others, and we need to make it fairly distributed." A
// property-wide setting would force one bargain onto everybody.
//
// An unticked charge is billed in FULL and takes no part in the credit at all —
// it does not even help earn it, or the excluded bill would quietly discount
// everything else.
const COVERABLE: { key: string; label: string }[] = [
  { key: 'rent',     label: 'Rent' },
  { key: 'electric', label: 'Electric' },
  { key: 'water',    label: 'Water' },
  { key: 'sewer',    label: 'Sewer' },
  { key: 'gas',      label: 'Natural gas' },
  { key: 'trash',    label: 'Trash' },
  { key: 'propane',  label: 'Propane' },
  { key: 'fees',     label: 'Fees' },
]

function AgreementCoversCell({ agreement }: { agreement: any }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const covered: string[] = agreement.coveredCharges ?? []
  const save = useMutation(
    (next: string[]) => apiPatch(`/work-trade/${agreement.id}`, { coveredCharges: next }),
    { onSuccess: () => { qc.invalidateQueries('work-trade'); toast('Saved — it applies from the next invoice.') },
      onError: (e: any) => toast.error(e?.response?.data?.error || 'Could not save that') },
  )
  const toggle = (key: string) => {
    const next = covered.includes(key) ? covered.filter(k => k !== key) : [...covered, key]
    save.mutate(next)
  }
  // S613 (Nic): the label states what IS covered, and never editorialises.
  //
  //   "Why would a selectable list be titled 'all but propane' if other things
  //    could be selected or unselected?"
  //
  // Right — that phrasing implied propane was the special one, when every line
  // in the list is equally selectable, and it described the control by what is
  // MISSING from it. A picker should say what it holds and invite the choice.
  const chosen = COVERABLE.filter(c => covered.includes(c.key))
  const label = chosen.length === 0 ? 'Choose…'
    : chosen.length === COVERABLE.length ? 'Everything'
    : chosen.length <= 3 ? chosen.map(c => c.label).join(', ')
    : `${chosen.slice(0, 2).map(c => c.label).join(', ')} +${chosen.length - 2}`

  return (
    <div style={{ position: 'relative' }}>
      <button className="btn btn-ghost btn-sm"
        style={{ fontSize: '.72rem', padding: '2px 8px', display: 'flex', alignItems: 'center', gap: 5,
                 color: chosen.length === 0 ? 'var(--text-3)' : undefined }}
        title={chosen.length ? `Covers ${chosen.map(c => c.label.toLowerCase()).join(', ')}` : 'Nothing selected yet'}
        onClick={() => setOpen(o => !o)}>
        {label}
        <ChevronDown size={12} style={{ color: 'var(--text-3)' }} />
      </button>
      {open && (
        <div style={{ position: 'absolute', zIndex: 30, top: '100%', left: 0, marginTop: 4, minWidth: 190,
                      background: 'var(--bg-1)', border: '1px solid var(--border-0)', borderRadius: 8,
                      padding: 8, boxShadow: '0 8px 24px rgba(0,0,0,.35)' }}>
          <div style={{ fontSize: '.66rem', color: 'var(--text-3)', marginBottom: 6, lineHeight: 1.5 }}>
            Choose what the hours trade for. Anything unticked is billed in full.
          </div>
          {COVERABLE.map(c => (
            <label key={c.key} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '3px 2px',
                                        fontSize: '.76rem', cursor: 'pointer' }}>
              <input type="checkbox" checked={covered.includes(c.key)}
                disabled={save.isLoading} onChange={() => toggle(c.key)} />
              {c.label}
            </label>
          ))}
          <button className="btn btn-ghost btn-sm" style={{ marginTop: 6, width: '100%', fontSize: '.7rem' }}
            onClick={() => setOpen(false)}>Done</button>
        </div>
      )}
    </div>
  )
}

// W-56: per-person monthly hours target, edited inline on the roster row.
function AgreementTargetCell({ agreementId, target }: { agreementId: string; target: number }) {
  const qc = useQueryClient()
  const [value, setValue] = useState<string | null>(null)
  const shown = value ?? String(target)
  const save = useMutation(
    (t: number) => apiPatch(`/work-trade/${agreementId}`, { monthlyHoursTarget: t }),
    { onSuccess: () => { qc.invalidateQueries('work-trade'); setValue(null) } }
  )
  const dirty = value != null && Number(value) !== target && Number(value) > 0
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <input type="number" min={1} value={shown} onChange={e => setValue(e.target.value)}
        style={{ width: 64, padding: '4px 6px', textAlign: 'right' }} className="input" />
      <span style={{ color: 'var(--text-3)', fontSize: '.72rem' }}>hrs</span>
      {dirty && (
        <button className="btn btn-primary btn-sm" disabled={save.isLoading}
          onClick={() => save.mutate(Number(shown))}>
          {save.isLoading ? '…' : 'Save'}
        </button>
      )}
    </div>
  )
}

/**
 * S624 — how long a shortfall may carry before it is billed and the agreement ends.
 *
 * Nic: "my two month rule was just an example. If a landlord wants to give
 * leniency for six months, they may choose to do so or however long. But at some
 * point, a landlord's gonna know that somebody's never gonna be able to
 * physically catch up. There's just not that many hours in a month."
 *
 * So it is a setting, not a constant — and the copy names the consequence rather
 * than the mechanism, because "carry_forward_months" means nothing to anybody.
 */
function CarryForwardCell({ agreementId, months }: { agreementId: string; months: number }) {
  const qc = useQueryClient()
  const [value, setValue] = useState<string | null>(null)
  const shown = value ?? String(months ?? 1)
  const save = useMutation(
    (m: number) => apiPatch(`/work-trade/${agreementId}`, { carryForwardMonths: m }),
    { onSuccess: () => { qc.invalidateQueries('work-trade'); setValue(null) } }
  )
  const n = Number(shown)
  const dirty = value != null && n !== months && n >= 0 && n <= 24
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <input type="number" min={0} max={24} value={shown}
          onChange={e => setValue(e.target.value)}
          style={{ width: 56, padding: '4px 6px', textAlign: 'right' }} className="input" />
        <span style={{ color: 'var(--text-3)', fontSize: '.72rem' }}>
          {n === 1 ? 'month' : 'months'}
        </span>
        {dirty && (
          <button className="btn btn-primary btn-sm" disabled={save.isLoading}
            onClick={() => save.mutate(n)}>
            {save.isLoading ? '…' : 'Save'}
          </button>
        )}
      </div>
      <div style={{ fontSize: '.68rem', color: 'var(--text-3)', marginTop: 3, lineHeight: 1.4 }}>
        {n === 0
          ? 'Unworked hours are billed at the end of the month they were owed.'
          : `Unworked hours carry for ${n} more ${n === 1 ? 'month' : 'months'}. After that they're billed and the agreement ends.`}
      </div>
    </div>
  )
}

// S622 (Nic): "how do I initiate that agreement so somebody could track hours,
// just so I can start experimenting on that flow?"
//
// POST /work-trade has existed since S397 and NOTHING in the portal ever called
// it — the page could list agreements and send addenda, but never create one.
// Hour tracking was reachable only by API.
//
// NO TEMPLATE IS INVOLVED, and the modal says so, because the Templates screen
// offering a "Work-Trade Addendum" form type implies otherwise. Nic: "I don't
// understand the need to have a separate template for it... in terms of just
// tracking the hours, I don't think it's necessary." He is right.
// work_trade_agreements carries no template or document reference. The server's
// only requirement is an ACTIVE lease for that tenant on that unit, because
// rent-for-labor needs a rent obligation to offset. The addendum form is
// separate, optional paperwork for stating duties in writing.
function NewAgreementModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const [leaseKey, setLeaseKey] = useState('')
  const [hours, setHours] = useState('')
  const [duties, setDuties] = useState('')
  const [startDate, setStartDate] = useState(new Date().toISOString().slice(0, 10))
  const [covers, setCovers] = useState<string[]>([])
  const [err, setErr] = useState('')

  // Only a LIVE tenancy can hold a work-trade agreement, so the picker offers
  // exactly those pairs rather than letting the landlord choose something the
  // server will refuse.
  const { data: leases = [] } = useQuery<any[]>('wt-active-leases', () => apiGet('/leases'))
  const options = (leases as any[])
    .filter((l: any) => l.status === 'active')
    .flatMap((l: any) => (l.tenants || [])
      .filter((t: any) => t.status === 'active')
      .map((t: any) => ({
        key: `${l.unitId}:${t.tenantId ?? t.id}`,
        unitId: l.unitId,
        tenantId: t.tenantId ?? t.id,
        label: `${(t.firstName ?? '').trim()} ${(t.lastName ?? '').trim()}`.trim() +
               ` — Unit ${l.unitNumber ?? '—'}${l.propertyName ? ` (${l.propertyName})` : ''}`,
      })))

  const picked = options.find(o => o.key === leaseKey)

  const save = useMutation(
    () => apiPost('/work-trade', {
      unitId: picked!.unitId,
      tenantId: picked!.tenantId,
      startDate,
      duties: duties.trim() || undefined,
      monthlyHoursTarget: hours.trim() ? Number(hours) : undefined,
      // Omitted = covers everything, which is what every agreement before S613 did.
      coveredCharges: covers.length ? covers : undefined,
    }),
    {
      onSuccess: () => { qc.invalidateQueries('work-trade'); toast('Work-trade agreement created.'); onClose() },
      onError: (e: any) => setErr(e?.response?.data?.error || e?.message || 'Could not create the agreement'),
    })

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.5)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center', padding:16 }}
      onClick={onClose}>
      <div className="card" style={{ width:'100%', maxWidth:520, padding:20, maxHeight:'90vh', overflowY:'auto' }}
        onClick={e => e.stopPropagation()}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:4 }}>
          <div className="modal-title">New work-trade agreement</div>
          <button className="btn btn-ghost btn-sm" onClick={onClose}><X size={14} /></button>
        </div>
        <div style={{ fontSize:'.78rem', color:'var(--text-3)', marginBottom:14, lineHeight:1.5 }}>
          Hours logged against this agreement buy a percent of the tenant's monthly bill.
          No template or signed form is needed to track hours — if you want the duties
          in writing, send a Work-Trade Addendum from the row afterwards.
        </div>

        {err && <div style={{ background:'rgba(239,68,68,.12)', border:'1px solid rgba(239,68,68,.4)', padding:'8px 10px', borderRadius:6, fontSize:'.78rem', marginBottom:12 }}>{err}</div>}

        <label style={{ fontSize:'.72rem', color:'var(--text-3)', display:'block', marginBottom:4 }}>Tenant &amp; unit</label>
        <select className="input" value={leaseKey} onChange={e => setLeaseKey(e.target.value)} style={{ width:'100%', marginBottom:12 }}>
          <option value="">— Choose an active tenancy —</option>
          {options.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
        </select>
        {options.length === 0 && (
          <div style={{ fontSize:'.72rem', color:'var(--text-3)', marginTop:-6, marginBottom:12 }}>
            No active tenancies yet. Work trade offsets rent, so it needs a live lease first.
          </div>
        )}

        <div style={{ display:'flex', gap:12, marginBottom:12 }}>
          <div style={{ flex:1 }}>
            <label style={{ fontSize:'.72rem', color:'var(--text-3)', display:'block', marginBottom:4 }}>Start date</label>
            <input className="input" type="date" value={startDate} onChange={e => setStartDate(e.target.value)} style={{ width:'100%' }} />
          </div>
          <div style={{ flex:1 }}>
            <label style={{ fontSize:'.72rem', color:'var(--text-3)', display:'block', marginBottom:4 }}>Monthly hours target</label>
            <input className="input" inputMode="numeric" placeholder="property default" value={hours}
              onChange={e => setHours(e.target.value.replace(/[^0-9]/g, ''))} style={{ width:'100%' }} />
          </div>
        </div>

        <label style={{ fontSize:'.72rem', color:'var(--text-3)', display:'block', marginBottom:4 }}>Duties (optional)</label>
        <textarea className="input" value={duties} onChange={e => setDuties(e.target.value)} rows={2}
          placeholder="Grounds work, snow removal…" style={{ width:'100%', marginBottom:12 }} />

        <label style={{ fontSize:'.72rem', color:'var(--text-3)', display:'block', marginBottom:6 }}>
          What the hours pay for <span style={{ opacity:.8 }}>— leave all unchecked for the whole bill</span>
        </label>
        <div style={{ display:'flex', flexWrap:'wrap', gap:8, marginBottom:16 }}>
          {COVERABLE.map(c => (
            <label key={c.key} style={{ display:'flex', alignItems:'center', gap:5, fontSize:'.76rem' }}>
              <input type="checkbox" checked={covers.includes(c.key)}
                onChange={e => setCovers(prev => e.target.checked ? [...prev, c.key] : prev.filter(x => x !== c.key))} />
              {c.label}
            </label>
          ))}
        </div>

        <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!picked || save.isLoading}
            onClick={() => { setErr(''); save.mutate() }}>
            {save.isLoading ? <span className="spinner" /> : 'Create agreement'}
          </button>
        </div>
      </div>
    </div>
  )
}
