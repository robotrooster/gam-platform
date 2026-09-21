import { useState } from 'react'
import { useQuery, useQueryClient } from 'react-query'
import { apiGet, apiPut } from '../lib/api'
import { toast } from '../components/dialogs'
import { jurisdictionLabel, UNIT_TYPE_LABEL } from '@gam/shared'
import { ensureLibraryCopy } from './TemplateLibrarySection'
import { ChevronDown, ChevronRight, Eye, Landmark, Plus, RefreshCw, Settings, Trash2 } from 'lucide-react'

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
  signable?: boolean   // false: the publisher locked the PDF — view only
  coveredBy?: Array<{ templateId: string; name: string; source?: 'auto' | 'manual'; evidence?: string | null }>
  group?: string
  freeVersion?: { libraryDocumentId: string; title: string; publishedBy: string; pdfUrl: string; templateId: string | null; signable?: boolean } | null
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
  all_rentals: 'For every rental',
  mobile_home_lots: 'Mobile home lots',
  rv_sites: 'RV & camp sites',
  storage: 'Storage',
  // Sent when something happens — never part of a signing packet.
  notices_later: 'Notices you send later',
  // Nic: "a section underneath all of that that shows free-use versions."
  government: 'Free government versions',
}
const GROUP_ORDER = Object.keys(GROUP_LABEL)


export default function TemplateSleeves({ canEdit, onEdit, onUpload, onMakeDefault, onDelete, onReplacePdf }: {
  canEdit: boolean
  onEdit: (templateId: string) => void
  onReplacePdf: (card: SleeveCard) => void
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

  // S652 — CARDS ARE WIDE AND SHORT. Nic: "make the cards more rectangular,
  // squish them a little bit and stretch them out... everything for a state
  // should fit easily into one page... the title for my lease template, Mountain
  // View RV Spot Lease, dot, dot, dot — it's cut off." So: the actions sit on the
  // title line as small buttons instead of a row of their own, nothing is
  // truncated (names wrap), and the grid fills the width.
  const iconBtn: React.CSSProperties = { padding: '2px 6px', lineHeight: 1, minHeight: 0 }
  const renderSleeve = (s: Sleeve, state: string) => {
    const gov = s.kind === 'government'
    const covered = !gov && s.cards.length === 0 && (s.coveredBy?.length ?? 0) > 0
    const free = !gov && s.cards.length === 0 && !covered ? s.freeVersion ?? null : null
    const empty = !gov && s.cards.length === 0 && !covered
    const editingCover = covering?.sleeveId === s.id
    return (
      <div key={s.id} style={{
        padding: '7px 10px', borderRadius: 8, display: 'flex', flexDirection: 'column', gap: 4,
        background: s.filled ? 'var(--bg-2, var(--surface-2))' : 'transparent',
        border: s.filled ? '1px solid var(--border-0)' : '1px dashed var(--border-1)',
      }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
          <span style={{ fontSize: '.64rem', fontWeight: 700, color: 'var(--text-3)', minWidth: 14, paddingTop: 2 }}>{s.number}</span>
          <span style={{ flex: 1, fontSize: '.78rem', fontWeight: 600, lineHeight: 1.3,
                         color: s.filled ? 'var(--text-0)' : 'var(--text-3)' }}>
            {shortTitle(s.title)}
            {gov && <span title={s.publishedBy}><Landmark size={11} style={{ color: 'var(--gold)', marginLeft: 5, verticalAlign: '-1px' }} /></span>}
            {gov && s.signable === false && (
              <span title="The publisher locked this PDF against editing, so it can be viewed and handed out but not signed"
                    style={{ marginLeft: 5, fontSize: '.54rem', fontWeight: 700, color: 'var(--text-3)', border: '1px solid var(--border-1)', borderRadius: 3, padding: '0 3px' }}>READ ONLY</span>
            )}
          </span>
          {gov && (
            <span style={{ display: 'flex', gap: 3, flexShrink: 0 }}>
              <button className="btn btn-primary btn-sm" style={iconBtn} title="View" onClick={() => openPdf(s.pdfUrl!)}><Eye size={11} /></button>
              {canEdit && s.signable !== false && (
                <button className="btn btn-primary btn-sm" style={iconBtn} title="Edit boxes" disabled={busy === s.id}
                        onClick={() => editGovernment(s)}><Settings size={11} /></button>
              )}
            </span>
          )}
          {empty && canEdit && !editingCover && (
            <span style={{ display: 'flex', gap: 3, flexShrink: 0 }}>
              <button className="btn btn-primary btn-sm" style={iconBtn} title="Upload" onClick={() => onUpload(s, state)}><Plus size={11} /></button>
            </span>
          )}
        </div>

        {/* what fills it — every name, wrapping, never cut off */}
        {!gov && s.cards.map(c => (
          <div key={c.templateId} style={{ display: 'flex', alignItems: 'flex-start', gap: 6, paddingLeft: 20 }}>
            <span style={{ flex: 1, fontSize: '.72rem', color: 'var(--text-1)', lineHeight: 1.3 }}>
              {c.name}
              {c.isUnitTypeDefault && <span style={{ marginLeft: 5, fontSize: '.54rem', fontWeight: 700, color: 'var(--gold)', border: '1px solid var(--gold)', borderRadius: 3, padding: '0 3px' }}>DEFAULT</span>}
              <span style={{ color: 'var(--text-3)', fontSize: '.64rem' }}> · {c.propertyName || 'any property'} · {c.fieldCount} boxes</span>
            </span>
            {canEdit && (
              <span style={{ display: 'flex', gap: 3, flexShrink: 0 }}>
                <button className="btn btn-primary btn-sm" style={iconBtn} title="Edit boxes" onClick={() => onEdit(c.templateId)}><Settings size={11} /></button>
                <button className="btn btn-primary btn-sm" style={iconBtn} title="Replace the PDF — boxes stay where they are" onClick={() => onReplacePdf(c)}><RefreshCw size={11} /></button>
                {s.kind === 'lease' && !c.isUnitTypeDefault && (
                  <button className="btn btn-primary btn-sm" style={{ ...iconBtn, fontSize: '.6rem' }} title="Use this lease for new leases of this unit type" onClick={() => onMakeDefault(c.templateId)}>Default</button>
                )}
                <button className="btn btn-ghost btn-sm" style={{ ...iconBtn, color: 'var(--red)' }} title="Delete" onClick={() => onDelete(c)}><Trash2 size={11} /></button>
              </span>
            )}
          </div>
        ))}
        {!gov && s.cards.length > 0 && canEdit && (
          <button className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-start', fontSize: '.62rem', padding: '0 4px', marginLeft: 16 }}
                  onClick={() => onUpload(s, state)}><Plus size={9} /> Add another</button>
        )}

        {free && (
          <div style={{ paddingLeft: 20, display: 'flex', alignItems: 'flex-start', gap: 6 }}>
            <span style={{ flex: 1, fontSize: '.7rem', lineHeight: 1.35 }} title={free.publishedBy}>
              <span style={{ color: 'var(--text-3)' }}>Free version: </span>
              <span style={{ color: 'var(--text-1)' }}>{shortTitle(free.title)}</span>
              <Landmark size={10} style={{ color: 'var(--gold)', marginLeft: 4, verticalAlign: '-1px' }} />
            </span>
            <span style={{ display: 'flex', gap: 3, flexShrink: 0 }}>
              <button className="btn btn-primary btn-sm" style={iconBtn} title="View" onClick={() => openPdf(free.pdfUrl)}><Eye size={11} /></button>
              {canEdit && free.signable !== false && (
                <button className="btn btn-primary btn-sm" style={iconBtn} title="Edit boxes"
                  onClick={() => editGovernment({ ...s, cards: free.templateId ? [{ templateId: free.templateId } as any] : [], libraryDocumentId: free.libraryDocumentId })}>
                  <Settings size={11} />
                </button>
              )}
            </span>
          </div>
        )}

        {covered && !editingCover && (
          <div style={{ paddingLeft: 20, fontSize: '.7rem', lineHeight: 1.45 }}>
            {s.coveredBy!.map((c, i) => (
              <span key={c.templateId} title={c.source === 'auto' && c.evidence ? `Read from the document: "${c.evidence}"` : undefined}>
                {i === 0 && <span style={{ color: 'var(--text-3)' }}>{c.source === 'auto' ? 'Found in ' : 'Included in '}</span>}
                <span style={{ color: 'var(--text-1)' }}>{c.name}</span>{i < s.coveredBy!.length - 1 ? ', ' : ''}
              </span>
            ))}
            {canEdit && (
              <button className="btn btn-ghost btn-sm" style={{ fontSize: '.6rem', padding: '0 4px', marginLeft: 4 }}
                      onClick={() => setCovering({ sleeveId: s.id, ids: s.coveredBy!.map(c => c.templateId) })}>Change</button>
            )}
          </div>
        )}

        {empty && canEdit && !editingCover && s.kind === 'disclosure' && s.group !== 'notices_later' && ownDocs.length > 0 && (
          <button className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-start', fontSize: '.62rem', padding: '0 4px', marginLeft: 16 }}
                  onClick={() => setCovering({ sleeveId: s.id, ids: [] })}>It's in another document</button>
        )}

        {editingCover && (
          <div style={{ paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 3 }}>
            <div style={{ fontSize: '.66rem', color: 'var(--text-2)' }}>Which of your documents already include this?</div>
            {ownDocs.map(d => (
              <label key={d.templateId} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '.7rem', color: 'var(--text-1)' }}>
                <input type="checkbox" checked={covering!.ids.includes(d.templateId)}
                  onChange={e => setCovering({ sleeveId: s.id, ids: e.target.checked
                    ? [...covering!.ids, d.templateId] : covering!.ids.filter(x => x !== d.templateId) })} />
                {d.name}
              </label>
            ))}
            <div style={{ display: 'flex', gap: 6, marginTop: 3 }}>
              <button className="btn btn-primary btn-sm" onClick={() => saveCoverings(s.id, covering!.ids)}>Save</button>
              <button className="btn btn-ghost btn-sm" onClick={() => setCovering(null)}>Cancel</button>
            </div>
          </div>
        )}
      </div>
    )
  }

  const section = (key: string, label: string, sub: string, sleeves: Sleeve[], state: string) => {
    // Nic: "have everything closed by default... you don't want to close
    // freaking 10 states to get down to the state that you want."
    const isClosed = closed[key] ?? true
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
                <div key={g} style={{ marginTop: 8 }}>
                  <div style={{ fontSize: '.64rem', fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase',
                                color: 'var(--text-3)', margin: '2px 0 5px' }}>{GROUP_LABEL[g]}</div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 6 }}>
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
