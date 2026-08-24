import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { apiGet, apiPatch, apiPost } from '../lib/api'
import { ChevronDown } from 'lucide-react'
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
      </div>

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
            <thead><tr><th>Tenant</th><th>Unit</th><th>Property</th><th>This Month</th><th>Target</th><th>Covers</th><th>Pending</th><th>Start</th><th>Status</th><th>Addendum</th></tr></thead>
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
