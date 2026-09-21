import { useState } from 'react'
import { useQuery, useQueryClient } from 'react-query'
import { apiGet, apiPut } from '../lib/api'
import { toast } from '../components/dialogs'
import { jurisdictionLabel, UNIT_TYPE_LABEL } from '@gam/shared'
import { ensureLibraryCopy } from './TemplateLibrarySection'
import { ChevronDown, ChevronRight, Eye, Landmark, Plus, Settings, Trash2 } from 'lucide-react'

const API_URL = (import.meta as any).env?.VITE_API_URL || 'http://localhost:4000'

/**
 * S652 — THE TEMPLATES PAGE AS A CARD COLLECTION.
 *
 * Nic: "if I upload my Arizona property and twelve documents are anticipated,
 * that shows twelve blanks. The landlord can just upload into spots they want to
 * use. They're not required to use the blank spots. But that hint of hey,
 * there's more things to upload is there." His words: the SLEEVE is the slot,
 * the CARD is the document in it.
 *
 * One section per state the landlord holds property in, numbered like a set so a
 * gap reads as a gap. Government forms come in their sleeves already. Nothing on
 * this page says a document is required — "we just want to have it be a little
 * more subtle." An empty sleeve is dashed and quiet, with Upload, and that is all.
 */
export type SleeveCard = {
  templateId: string; name: string; propertyName?: string | null
  fieldCount: number; pageCount: number; isUnitTypeDefault?: boolean
  purpose?: string; unitType?: string | null
}
export type Sleeve = {
  id: string; kind: 'lease' | 'sale_contract' | 'disclosure' | 'government'
  title: string; number: number; filled: boolean; unitTypes: string[] | null
  cards: SleeveCard[]; libraryDocumentId?: string; publishedBy?: string; pdfUrl?: string
  coveredBy?: Array<{ templateId: string; name: string }>
  group?: string
}
type StateGroup = { state: string; unitTypes: string[]; sleeves: Sleeve[]; filled: number; total: number }
export type SleevesData = { states: StateGroup[]; federal: Sleeve[]; other: SleeveCard[] }

export const useSleeves = () => useQuery<SleevesData>('esign-sleeves', () => apiGet<SleevesData>('/esign/sleeves'))

async function openPdf(url: string) {
  const res = await fetch(`${url.startsWith('http') ? '' : API_URL}${url}`, {
    headers: { Authorization: 'Bearer ' + (localStorage.getItem('gam_token') || '') },
  })
  if (!res.ok) { toast.error('Could not open that form'); return }
  window.open(URL.createObjectURL(await res.blob()), '_blank', 'noopener')
}

// Inside a state's section the state is said once, in the header, and the
// kind of space in the group heading — so neither is repeated on each card.
const shortTitle = (title: string) =>
  title.replace(/^[A-Z][A-Za-z .]+:\s+/, '').replace(/\s+\((?:Mobile Home Lots|RV & Camp Sites|Storage|Commercial)\)$/, '')

// Nic: "maybe we break it down... some of them say RV or mobile home or
// campsites... it needs more organization."
const GROUP_LABEL: Record<string, string> = {
  contracts: 'Leases & contracts',
  government: 'Government forms',
  all_rentals: 'For every rental',
  mobile_home_lots: 'Mobile home lots',
  rv_sites: 'RV & camp sites',
  storage: 'Storage',
}
const GROUP_ORDER = Object.keys(GROUP_LABEL)

const cardStyle = (filled: boolean): React.CSSProperties => ({
  padding: '10px 12px', borderRadius: 10, minHeight: 92, display: 'flex', flexDirection: 'column', gap: 6,
  background: filled ? 'var(--bg-2, var(--surface-2))' : 'transparent',
  border: filled ? '1px solid var(--border-0)' : '1px dashed var(--border-1)',
})

export default function TemplateSleeves({ canEdit, onEdit, onUpload, onMakeDefault, onDelete }: {
  canEdit: boolean
  onEdit: (templateId: string) => void
  onUpload: (sleeve: Sleeve, state: string) => void
  onMakeDefault: (templateId: string) => void
  onDelete: (card: SleeveCard) => void
}) {
  const qc = useQueryClient()
  const { data, isLoading } = useSleeves()
  const [closed, setClosed] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [covering, setCovering] = useState<{ sleeveId: string; ids: string[] } | null>(null)

  if (isLoading) return <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-3)' }}>Loading…</div>
  if (!data) return null

  // Every document of their own, for "Already in…". Blu's park rules are
  // Exhibit B of his lease; this lets that sleeve say so instead of looking empty.
  const ownDocs = [
    ...data.states.flatMap(st => st.sleeves.filter(s => s.kind !== 'government').flatMap(s => s.cards)),
    ...data.other,
  ].filter((c, i, a) => a.findIndex(x => x.templateId === c.templateId) === i)

  // "It's in another document": the landlord ticks which of their own documents
  // already contain this one. Nothing is detected — they say so, and can tick
  // more than one (two properties, one attorney's lease).
  const saveCoverings = async (sleeveId: string, ids: string[]) => {
    try {
      await apiPut(`/esign/sleeves/${sleeveId}/cover`, { templateIds: ids })
      qc.invalidateQueries('esign-sleeves'); setCovering(null)
    } catch (e: any) { toast.error(e?.message || 'Could not save that') }
  }

  const editGovernment = async (s: Sleeve) => {
    setBusy(s.id)
    try {
      const id = s.cards[0]?.templateId ?? await ensureLibraryCopy(s.libraryDocumentId!)
      qc.invalidateQueries('esign-sleeves')
      onEdit(id)
    } catch (e: any) { toast.error(e?.message || 'Could not open that form') }
    finally { setBusy(null) }
  }

  const renderSleeve = (s: Sleeve, state: string) => {
    const gov = s.kind === 'government'
    return (
      <div key={s.id} style={cardStyle(s.filled)}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
          <span style={{ fontSize: '.66rem', fontWeight: 700, color: 'var(--text-3)', minWidth: 16 }}>{s.number}</span>
          <span style={{ flex: 1, fontSize: '.8rem', fontWeight: 600, lineHeight: 1.3,
                         color: s.filled ? 'var(--text-0)' : 'var(--text-3)' }}>
            {shortTitle(s.title)}
          </span>
          {gov && <span title={s.publishedBy}><Landmark size={13} style={{ color: 'var(--gold)', flexShrink: 0 }} /></span>}
        </div>

        {gov ? (
          <div style={{ display: 'flex', gap: 6, marginTop: 'auto' }}>
            <button className="btn btn-primary btn-sm" onClick={() => openPdf(s.pdfUrl!)}><Eye size={11} /> View</button>
            {canEdit && (
              <button className="btn btn-primary btn-sm" disabled={busy === s.id} onClick={() => editGovernment(s)}>
                <Settings size={11} /> {busy === s.id ? 'Opening…' : 'Edit boxes'}
              </button>
            )}
          </div>
        ) : covering?.sleeveId === s.id ? (
          <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ fontSize: '.68rem', color: 'var(--text-2)' }}>Which of your documents already include this?</div>
            {ownDocs.map(d => (
              <label key={d.templateId} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '.72rem', color: 'var(--text-1)' }}>
                <input type="checkbox" checked={covering.ids.includes(d.templateId)}
                  onChange={e => setCovering({ sleeveId: s.id, ids: e.target.checked
                    ? [...covering.ids, d.templateId] : covering.ids.filter(x => x !== d.templateId) })} />
                {d.name}
              </label>
            ))}
            <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
              <button className="btn btn-primary btn-sm" onClick={() => saveCoverings(s.id, covering.ids)}>Save</button>
              <button className="btn btn-ghost btn-sm" onClick={() => setCovering(null)}>Cancel</button>
            </div>
          </div>
        ) : s.coveredBy && s.coveredBy.length > 0 ? (
          <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 3 }}>
            <span style={{ fontSize: '.68rem', color: 'var(--text-3)' }}>Included in</span>
            {s.coveredBy.map(c => (
              <span key={c.templateId} style={{ fontSize: '.72rem', color: 'var(--text-1)' }}>{c.name}</span>
            ))}
            {canEdit && (
              <button className="btn btn-primary btn-sm" style={{ alignSelf: 'flex-start', marginTop: 3 }}
                      onClick={() => setCovering({ sleeveId: s.id, ids: s.coveredBy!.map(c => c.templateId) })}>
                Change
              </button>
            )}
          </div>
        ) : s.cards.length === 0 ? (
          canEdit && (
            <div style={{ marginTop: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button className="btn btn-primary btn-sm" onClick={() => onUpload(s, state)}><Plus size={11} /> Upload</button>
              {/* Only a document can live inside another one — a lease or a sale
                  contract is its own document. */}
              {s.kind === 'disclosure' && ownDocs.length > 0 && (
                <button className="btn btn-primary btn-sm" onClick={() => setCovering({ sleeveId: s.id, ids: [] })}>
                  It's in another document
                </button>
              )}
            </div>
          )
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 'auto' }}>
            {s.cards.map(c => (
              <div key={c.templateId} style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <div style={{ flex: '1 1 110px', minWidth: 0 }}>
                  <div style={{ fontSize: '.74rem', color: 'var(--text-1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.name}>
                    {c.name}
                    {c.isUnitTypeDefault && <span style={{ marginLeft: 5, fontSize: '.56rem', fontWeight: 700, color: 'var(--gold)', border: '1px solid var(--gold)', borderRadius: 3, padding: '0 3px' }}>DEFAULT</span>}
                  </div>
                  <div style={{ fontSize: '.64rem', color: 'var(--text-3)' }}>
                    {c.propertyName || 'any property'} · {c.fieldCount} boxes
                  </div>
                </div>
                {canEdit && (
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button className="btn btn-primary btn-sm" onClick={() => onEdit(c.templateId)} title="Edit boxes"><Settings size={11} /></button>
                    {s.kind === 'lease' && !c.isUnitTypeDefault && (
                      <button className="btn btn-primary btn-sm" onClick={() => onMakeDefault(c.templateId)} title="Use this lease for new leases of this unit type">Default</button>
                    )}
                    <button className="btn btn-ghost btn-sm" style={{ color: 'var(--red)' }} onClick={() => onDelete(c)} title="Delete"><Trash2 size={11} /></button>
                  </div>
                )}
              </div>
            ))}
            {canEdit && (
              <button className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-start', fontSize: '.66rem', padding: '0 4px' }}
                      onClick={() => onUpload(s, state)}>
                <Plus size={10} /> Add another
              </button>
            )}
          </div>
        )}
      </div>
    )
  }

  const section = (key: string, label: string, sub: string, sleeves: Sleeve[], state: string) => {
    const isClosed = closed[key] ?? false
    return (
      <div key={key} className="card" style={{ padding: 0, marginBottom: 12, overflow: 'hidden' }}>
        <button onClick={() => setClosed({ ...closed, [key]: !isClosed })}
          style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '11px 14px', background: 'none',
                   border: 'none', cursor: 'pointer', color: 'var(--text-0)', textAlign: 'left' }}>
          {isClosed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
          <span style={{ fontSize: '.82rem', fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase' }}>{label}</span>
          <span style={{ fontSize: '.74rem', color: 'var(--text-3)' }}>{sub}</span>
        </button>
        {!isClosed && (
          <div style={{ padding: '0 14px 14px' }}>
            {GROUP_ORDER.map(g => {
              const inGroup = sleeves.filter(x => (x.group ?? (x.kind === 'government' ? 'government' : 'all_rentals')) === g)
              if (!inGroup.length) return null
              return (
                <div key={g} style={{ marginTop: 10 }}>
                  <div style={{ fontSize: '.68rem', fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase',
                                color: 'var(--text-3)', margin: '4px 0 8px' }}>{GROUP_LABEL[g]}</div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 10 }}>
                    {inGroup.map(x => renderSleeve(x, state))}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    )
  }

  return (
    <div>
      {data.states.length === 0 && (
        <div className="card" style={{ padding: 18, fontSize: '.82rem', color: 'var(--text-2)' }}>
          Add a property and its units, and the documents for that state and those kinds of space appear here.
        </div>
      )}

      {data.states.map(st => section(
        st.state, jurisdictionLabel(st.state),
        `· ${st.filled} of ${st.total} · ${st.unitTypes.map(u => (UNIT_TYPE_LABEL as any)[u] || u).join(', ')}`,
        st.sleeves, st.state))}

      {data.federal.length > 0 && section('US', 'Federal', `· ${data.federal.length} ${data.federal.length === 1 ? 'form' : 'forms'}`, data.federal, 'US')}

      {data.other.length > 0 && (
        <div className="card" style={{ padding: 0, marginBottom: 12, overflow: 'hidden' }}>
          <div style={{ padding: '11px 14px', fontSize: '.82rem', fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--text-0)' }}>
            Other documents
          </div>
          {data.other.map(c => (
            <div key={c.templateId} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 14px', borderTop: '1px solid var(--border-0)', flexWrap: 'wrap' }}>
              <div style={{ flex: '1 1 260px' }}>
                <div style={{ fontSize: '.84rem', fontWeight: 600, color: 'var(--text-0)' }}>{c.name}</div>
                <div style={{ fontSize: '.68rem', color: 'var(--text-3)' }}>{c.propertyName || 'any property'} · {c.fieldCount} boxes</div>
              </div>
              {canEdit && (
                <div style={{ display: 'flex', gap: 6 }}>
                  <button className="btn btn-primary btn-sm" onClick={() => onEdit(c.templateId)}><Settings size={12} /> Edit boxes</button>
                  <button className="btn btn-ghost btn-sm" style={{ color: 'var(--red)' }} onClick={() => onDelete(c)}><Trash2 size={12} /></button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
