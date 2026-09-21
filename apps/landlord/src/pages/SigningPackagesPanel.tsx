import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { apiGet, apiPost, apiPut, apiDelete } from '../lib/api'
import { toast, appConfirm } from '../components/dialogs'
import {
  LEASE_TEMPLATE_PURPOSE_LABEL, RENEWAL_BEHAVIORS, RENEWAL_BEHAVIOR_LABEL,
  UNIT_TYPES, UNIT_TYPE_LABEL, jurisdictionLabel,
} from '@gam/shared'
import { useLibrary, ensureLibraryCopy } from './TemplateLibrarySection'
import { useSleeves } from './TemplateSleeves'
import { Plus, Trash2, GripVertical, Package } from 'lucide-react'

/**
 * S641 — signing packages.
 *
 * Nic: "here's my package for park owned homes in Arizona. Here's my package for
 * tenant owned homes in Arizona. Here's my package for RV spots in Arizona…
 * you can select multiple of those documents that already have signing boxes
 * and create them into a package."
 *
 * A package is a landlord-level list bound to a unit type, so an Arizona RV
 * package works at the next Arizona RV park. Templates are never consumed by
 * being used — the same statement of policy belongs to every package that needs
 * it, which is the whole reason this is a list of references rather than copies.
 */
type Item = {
  itemId?: string
  templateId: string
  templateName?: string
  purpose?: string
  sortOrder?: number
  renewalBehavior?: string
  required?: boolean
}
type Pkg = {
  id: string
  name: string
  description: string | null
  unitType: string | null
  stateCode?: string | null
  isDefault: boolean
  items: Item[]
}
type Template = { id: string; name: string; purpose: string; unitType: string | null; libraryDocumentId?: string | null; stateCode?: string | null }

export default function SigningPackagesPanel() {
  const qc = useQueryClient()
  const [editing, setEditing] = useState<Partial<Pkg> | null>(null)

  const { data: packages = [], isLoading } =
    useQuery<Pkg[]>('signing-packages', () => apiGet<Pkg[]>('/signing-packages'))
  const { data: templates = [] } =
    useQuery<Template[]>('esign-templates-all', () => apiGet<Template[]>('/esign/templates'))

  const save = useMutation(
    (p: Partial<Pkg>) => p.id
      ? apiPut(`/signing-packages/${p.id}`, p)
      : apiPost('/signing-packages', p),
    {
      onSuccess: () => { qc.invalidateQueries('signing-packages'); setEditing(null); toast('Package saved') },
      onError: (e: any) => toast.error(e?.message || 'Could not save that package'),
    })

  const archive = useMutation((id: string) => apiDelete(`/signing-packages/${id}`), {
    onSuccess: () => { qc.invalidateQueries('signing-packages'); toast('Package archived') },
  })

  if (isLoading) return <div style={{ color:'var(--text-3)' }}>Loading…</div>

  if (editing) {
    return <PackageEditor
      pkg={editing}
      templates={templates}
      onCancel={() => setEditing(null)}
      onSave={p => save.mutate(p)}
      saving={save.isLoading}
    />
  }

  return (
    <div>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:14 }}>
        <p style={{ color:'var(--text-3)', fontSize:'.82rem', margin:0, maxWidth:620 }}>
          A package is everything a resident signs in one sitting — the lease, plus whatever
          else applies to them. Pick what goes in it once, and drafting assembles the whole
          set instead of sending unrelated documents days apart.
        </p>
        <button className="btn btn-primary btn-sm" onClick={() => setEditing({ name:'', items:[] })}>
          <Plus size={14} /> New Package
        </button>
      </div>

      {packages.length === 0 && (
        <div style={{ padding:'28px 20px', textAlign:'center', color:'var(--text-3)',
                      border:'1px dashed var(--border-0)', borderRadius:10 }}>
          <Package size={26} style={{ opacity:.5, marginBottom:8 }} />
          <div style={{ fontSize:'.88rem' }}>No packages yet.</div>
          <div style={{ fontSize:'.78rem', marginTop:4 }}>
            Leases still send one at a time until you build one.
          </div>
        </div>
      )}

      <div style={{ display:'grid', gap:10 }}>
        {packages.map(p => (
          <div key={p.id} className="card" style={{ padding:'14px 16px' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', gap:12 }}>
              <div style={{ minWidth:0 }}>
                <div style={{ fontWeight:700, color:'var(--text-0)' }}>
                  {p.name}
                  {p.isDefault && (
                    <span style={{ marginLeft:8, fontSize:'.68rem', color:'var(--gold,#c9a227)',
                                   border:'1px solid var(--gold,#c9a227)', borderRadius:4, padding:'1px 6px' }}>
                      Default
                    </span>
                  )}
                </div>
                <div style={{ fontSize:'.75rem', color:'var(--text-3)', marginTop:2 }}>
                  {p.unitType ? (UNIT_TYPE_LABEL as any)[p.unitType] || p.unitType : 'Any unit type'}
                  {' · '}{p.items.length} document{p.items.length === 1 ? '' : 's'}
                </div>
                <div style={{ display:'flex', flexWrap:'wrap', gap:6, marginTop:8 }}>
                  {p.items.map(i => (
                    <span key={i.itemId || i.templateId}
                      style={{ fontSize:'.72rem', color:'var(--text-2)', background:'var(--bg-2,#141922)',
                               border:'1px solid var(--border-0)', borderRadius:5, padding:'2px 7px' }}>
                      {i.templateName}
                    </span>
                  ))}
                </div>
              </div>
              <div style={{ display:'flex', gap:6, flexShrink:0 }}>
                <button className="btn btn-ghost btn-sm" onClick={() => setEditing(p)}>Edit</button>
                <button className="btn btn-ghost btn-sm" style={{ color:'var(--red,#dc4c4c)' }}
                  onClick={async () => {
                    const ok = await appConfirm(
                      'Signed bundles keep their history — this only stops it being offered on new drafts.',
                      { title: `Archive “${p.name}”?`, confirmLabel: 'Archive', danger: true })
                    if (ok) archive.mutate(p.id)
                  }}>
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/** What kind of document a package row is — and for a library form, WHERE it
 *  is from, because "Disclosure" alone cannot tell an EPA form from Illinois'. */
function docKind(t: Template | undefined, fallbackPurpose?: string) {
  if (t?.libraryDocumentId) return jurisdictionLabel(t.stateCode)
  const kind = (LEASE_TEMPLATE_PURPOSE_LABEL as any)[t?.purpose || fallbackPurpose || 'lease']
  return t?.stateCode ? `${kind} · ${jurisdictionLabel(t.stateCode)}` : kind
}

function PackageEditor({ pkg, templates, onCancel, onSave, saving }: {
  pkg: Partial<Pkg>
  templates: Template[]
  onCancel: () => void
  onSave: (p: Partial<Pkg>) => void
  saving: boolean
}) {
  const [name, setName] = useState(pkg.name || '')
  const [unitType, setUnitType] = useState<string>(pkg.unitType || '')
  const [isDefault, setIsDefault] = useState(!!pkg.isDefault)
  const [items, setItems] = useState<Item[]>(pkg.items || [])

  const qc = useQueryClient()
  const { data: library } = useLibrary()
  const { data: sleeves } = useSleeves()
  // S652: a package is "my Arizona RV package" — its state is saved with it,
  // and is what the picker and Fill from my documents read.
  const [pickState, setPickState] = useState<string>(pkg.stateCode || '')
  const [adding, setAdding] = useState(false)
  const [sale, setSale] = useState(false)
  const myStates = sleeves?.states.map(s => s.state) ?? library?.operatingStates ?? []
  useEffect(() => {
    if (!pickState && myStates.length) setPickState(myStates[0])
  }, [myStates.join(','), pickState])

  /**
   * Nic: "based on the occupied sleeves that allows the package to help auto
   * pick which things are relevant to their operation." Every filled sleeve for
   * this state and unit type goes in, in the page's order: the default lease
   * where there are two, the government's forms (the Sales lead form for a home
   * sale, the Rentals one otherwise — never both), and nothing covered by
   * another document, since that document is already in. Existing items stay.
   */
  const fillFromSleeves = async () => {
    if (!sleeves) return
    const st = sleeves.states.find(x => x.state === pickState)
    const fits = (u: string[] | null) => !unitType || !u || u.includes(unitType)
    const wanted: Array<{ templateId?: string; lib?: string }> = []
    for (const s of [...(st?.sleeves ?? []), ...sleeves.federal] as any[]) {
      if (!fits(s.unitTypes) || s.coveredBy?.length) continue
      // A notice sent when something happens is never signed with the lease.
      if (s.group === 'notices_later') continue
      if (s.kind === 'sale_contract' && !sale) continue
      if (s.kind === 'government') {
        if (s.signable === false) continue       // read-only: the publisher locked it
        if (s.whenItHappens) continue            // e.g. Renovate Right: before renovation work, not at move-in
        if (s.appliesTo === 'sale' && !sale) continue
        if (s.appliesTo === 'rental' && sale) continue
        wanted.push(s.cards[0] ? { templateId: s.cards[0].templateId } : { lib: s.libraryDocumentId })
      } else if (s.cards.length) {
        const pick = s.kind === 'lease' ? (s.cards.find((c: any) => c.isUnitTypeDefault) ?? s.cards[0]) : s.cards[0]
        wanted.push({ templateId: pick.templateId })
      } else if (s.freeVersion && s.freeVersion.signable !== false) {
        // The state's own version, until the landlord uploads theirs.
        wanted.push(s.freeVersion.templateId ? { templateId: s.freeVersion.templateId } : { lib: s.freeVersion.libraryDocumentId })
      }
    }
    setAdding(true)
    try {
      const next = [...items]
      for (const w of wanted) {
        const templateId = w.templateId ?? await ensureLibraryCopy(w.lib!)
        if (!next.some(i => i.templateId === templateId)) {
          next.push({ templateId, sortOrder: next.length, renewalBehavior: 'with_lease' })
        }
      }
      setItems(next)
      qc.invalidateQueries('esign-templates-all'); qc.invalidateQueries('esign-sleeves')
      const added = next.length - items.length
      toast(added ? `Added ${added} document${added === 1 ? '' : 's'}` : 'Everything filled for this state and unit type is already in')
    } catch (e: any) {
      toast.error(e?.message || 'Could not fill the package')
    } finally { setAdding(false) }
  }

  const chosen = new Set(items.map(i => i.templateId))
  const ownAvailable = templates.filter(t => !t.libraryDocumentId && !chosen.has(t.id))
  const libFor = (j: string) => (library?.documents ?? [])
    .filter(d => d.jurisdiction === j && (d as any).signable !== false
                 && !(d.adoptedTemplateId && chosen.has(d.adoptedTemplateId)))
  // An already-copied form goes in by its template id; one never touched is
  // copied first (see the onChange above).
  const libValue = (d: { id: string; adoptedTemplateId: string | null }) =>
    d.adoptedTemplateId ?? `lib:${d.id}`

  const move = (from: number, to: number) => {
    if (to < 0 || to >= items.length) return
    const next = [...items]
    const [row] = next.splice(from, 1)
    next.splice(to, 0, row)
    setItems(next.map((r, i) => ({ ...r, sortOrder: i })))
  }

  return (
    <div>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
        <h2 style={{ margin:0, fontSize:'1.05rem', color:'var(--text-0)' }}>
          {pkg.id ? 'Edit package' : 'New package'}
        </h2>
        <div style={{ display:'flex', gap:8 }}>
          <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
          <button className="btn btn-primary" disabled={!name.trim() || saving}
            onClick={() => onSave({
              ...pkg, name: name.trim(),
              unitType: unitType || null, stateCode: pickState || null, isDefault,
              items: items.map((r, i) => ({
                templateId: r.templateId, sortOrder: i,
                renewalBehavior: r.renewalBehavior || 'with_lease',
                required: !!r.required,
              })),
            })}>
            {saving ? 'Saving…' : 'Save Package'}
          </button>
        </div>
      </div>

      <div className="card" style={{ padding:16, marginBottom:14 }}>
        <div style={{ display:'grid', gridTemplateColumns:'1.4fr 1fr 1fr', gap:12 }}>
          <label>
            <div className="form-label">Name</div>
            <input className="input" value={name} onChange={e => setName(e.target.value)}
              placeholder="Arizona park-owned homes" />
          </label>
          <label>
            <div className="form-label">Unit type</div>
            <select className="input" value={unitType} onChange={e => setUnitType(e.target.value)}>
              <option value="">Any unit type</option>
              {UNIT_TYPES.map(u => (
                <option key={u} value={u}>{(UNIT_TYPE_LABEL as any)[u] || u}</option>
              ))}
            </select>
          </label>
          <label>
            <div className="form-label">State</div>
            <select className="input" value={pickState} onChange={e => setPickState(e.target.value)}>
              {myStates.map(code => <option key={code} value={code}>{jurisdictionLabel(code)}</option>)}
            </select>
          </label>
        </div>
        <label style={{ display:'flex', alignItems:'center', gap:8, marginTop:12, fontSize:'.82rem', color:'var(--text-2)' }}>
          <input type="checkbox" checked={isDefault} onChange={e => setIsDefault(e.target.checked)} />
          Offer this one first when drafting for that unit type
        </label>
      </div>

      <div className="card" style={{ padding:16 }}>
        <div style={{ display:'flex', alignItems:'center', gap:10, flexWrap:'wrap', marginBottom:4 }}>
          <div style={{ fontWeight:700, color:'var(--text-0)', flex:1 }}>What is in it</div>
          <label style={{ display:'flex', alignItems:'center', gap:6, fontSize:'.76rem', color:'var(--text-2)' }}>
            <input type="checkbox" checked={sale} onChange={e => setSale(e.target.checked)} />
            Includes a home sale
          </label>
          <button className="btn btn-primary btn-sm" disabled={adding || !pickState} onClick={fillFromSleeves}>
            {adding ? 'Filling…' : 'Fill from my documents'}
          </button>
        </div>
        <div style={{ fontSize:'.76rem', color:'var(--text-3)', marginBottom:12 }}>
          In signing order. The lease usually goes first, then whatever explains or qualifies it.
        </div>

        {items.length === 0 && (
          <div style={{ fontSize:'.8rem', color:'var(--text-3)', padding:'10px 0' }}>
            Nothing added yet.
          </div>
        )}

        <div style={{ display:'grid', gap:8 }}>
          {items.map((it, idx) => {
            const t = templates.find(x => x.id === it.templateId)
            return (
              <div key={it.templateId} style={{ display:'flex', alignItems:'center', gap:10,
                    padding:'8px 10px', border:'1px solid var(--border-0)', borderRadius:8 }}>
                <div style={{ display:'flex', flexDirection:'column' }}>
                  <button className="btn btn-ghost btn-sm" style={{ padding:'0 4px', lineHeight:1 }}
                    disabled={idx === 0} onClick={() => move(idx, idx-1)} title="Move up">▲</button>
                  <button className="btn btn-ghost btn-sm" style={{ padding:'0 4px', lineHeight:1 }}
                    disabled={idx === items.length-1} onClick={() => move(idx, idx+1)} title="Move down">▼</button>
                </div>
                <GripVertical size={14} style={{ color:'var(--text-3)', flexShrink:0 }} />
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontWeight:600, color:'var(--text-1)', fontSize:'.86rem' }}>
                    {t?.name || it.templateName}
                  </div>
                  <div style={{ fontSize:'.7rem', color:'var(--text-3)' }}>
                    {docKind(t, it.purpose)}
                  </div>
                </div>
                <label style={{ fontSize:'.72rem', color:'var(--text-3)' }}>
                  <div className="form-label" style={{ fontSize:'.66rem' }}>At renewal</div>
                  <select className="input input-sm" value={it.renewalBehavior || 'with_lease'}
                    onChange={e => setItems(items.map((r,i) => i===idx ? { ...r, renewalBehavior: e.target.value } : r))}>
                    {RENEWAL_BEHAVIORS.map(b => (
                      <option key={b} value={b}>{RENEWAL_BEHAVIOR_LABEL[b]}</option>
                    ))}
                  </select>
                </label>
                <label style={{ display:'flex', alignItems:'center', gap:6, fontSize:'.74rem', color:'var(--text-2)' }}
                  title="Cannot be unticked when drafting">
                  <input type="checkbox" checked={!!it.required}
                    onChange={e => setItems(items.map((r,i) => i===idx ? { ...r, required: e.target.checked } : r))} />
                  Always
                </label>
                <button className="btn btn-ghost btn-sm" style={{ color:'var(--red,#dc4c4c)' }}
                  onClick={() => setItems(items.filter((_,i) => i !== idx))}>
                  <Trash2 size={13} />
                </button>
              </div>
            )
          })}
        </div>

        {/* S652 — Nic: "you click add a document, you select your state, and
            then any relevant documents to that state show up." Three groups
            so nobody mistakes an EPA form for an Illinois one: your own
            templates, Federal, and the chosen state's. A library form picked
            here gets the landlord's copy made on the spot. */}
        <div style={{ marginTop:14, display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
          <select className="input" value={pickState} style={{ width:'auto', minWidth:150 }}
            onChange={e => setPickState(e.target.value)} title="Show that state's government forms">
            {myStates.map(code => <option key={code} value={code}>{jurisdictionLabel(code)}</option>)}
          </select>
          <select className="input" value="" disabled={adding} style={{ maxWidth:420 }}
            onChange={async e => {
              const v = e.target.value
              if (!v) return
              let templateId = v
              if (v.startsWith('lib:')) {
                setAdding(true)
                try {
                  templateId = await ensureLibraryCopy(v.slice(4))
                  qc.invalidateQueries('esign-templates-all')
                  qc.invalidateQueries('esign-library')
                } catch (err: any) {
                  toast.error(err?.message || 'Could not add that form'); return
                } finally { setAdding(false) }
              }
              if (items.some(i => i.templateId === templateId)) return
              setItems([...items, { templateId, sortOrder: items.length, renewalBehavior: 'with_lease' }])
            }}>
            <option value="">{adding ? 'Adding…' : 'Add a document…'}</option>
            {ownAvailable.length > 0 && (
              <optgroup label="Your templates">
                {ownAvailable.map(t => (
                  <option key={t.id} value={t.id}>{t.name} · {(LEASE_TEMPLATE_PURPOSE_LABEL as any)[t.purpose] || t.purpose}</option>
                ))}
              </optgroup>
            )}
            {libFor('US').length > 0 && (
              <optgroup label="Federal">
                {libFor('US').map(d => <option key={d.id} value={libValue(d)}>{d.name}</option>)}
              </optgroup>
            )}
            <optgroup label={jurisdictionLabel(pickState)}>
              {libFor(pickState).length === 0
                ? <option disabled value="-">No {jurisdictionLabel(pickState)} forms in the library yet</option>
                : libFor(pickState).map(d => <option key={d.id} value={libValue(d)}>{d.name}</option>)}
            </optgroup>
          </select>
          <span style={{ fontSize:'.72rem', color:'var(--text-3)' }}>
            A document can be in as many packages as you like.
          </span>
        </div>
      </div>
    </div>
  )
}
