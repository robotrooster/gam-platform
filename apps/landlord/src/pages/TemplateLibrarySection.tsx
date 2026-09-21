import { useState } from 'react'
import { useQuery, useQueryClient } from 'react-query'
import { apiGet, apiPost } from '../lib/api'
import { toast } from '../components/dialogs'
import { jurisdictionLabel } from '@gam/shared'
import { Eye, Settings, ChevronDown, ChevronRight, Landmark } from 'lucide-react'

const API_URL = (import.meta as any).env?.VITE_API_URL || 'http://localhost:4000'

/**
 * S652 — the government library, as the lower half of the Templates page.
 *
 * Nic: "the whole library should be in the templates... all the government
 * forms are there by default, titled what they are... have it where the
 * landlord uploaded templates are pinned in like a top row and all the library
 * is... a clear section header that says library."
 *
 * Every form is simply THERE. There is no "add to my templates" step: the first
 * time a landlord edits a form's boxes (or puts it in a package), their own copy
 * is made behind the scenes, and after that it is theirs to place boxes on. A
 * form nobody has touched is never copied at all, so it is always the current
 * edition. Nothing here can be deleted.
 *
 * Grouped Federal first, then each state. States the landlord operates in open;
 * the rest stay folded, so fifty states of forms do not bury the two they use.
 *
 * WHAT THIS NEVER SAYS: that a form is required. A landlord with parks in three
 * states decides what applies to them.
 */
export type LibraryDoc = {
  id: string
  name: string
  description: string | null
  jurisdiction: string
  publishedBy: string
  pdfUrl: string
  pageCount: number
  effectiveFrom: string | null
  adoptedTemplateId: string | null
  fieldCount: number | null
  sourceUrl?: string
}
export type LibraryData = { documents: LibraryDoc[]; operatingStates: string[] }

export const useLibrary = () =>
  useQuery<LibraryData>('esign-library', () => apiGet<LibraryData>('/esign/library'))

/**
 * The landlord's own copy of a library form, made the first time it is needed.
 * Safe to call repeatedly — the server returns the existing copy.
 */
export async function ensureLibraryCopy(documentId: string): Promise<string> {
  const r = await apiPost<{ templateId: string }>('/esign/library/adopt', { documentId })
  return (r as any).data.templateId
}

async function openPdf(url: string) {
  // The file route needs the login and a plain link cannot carry it, so the
  // PDF is fetched with the token and handed to a new tab as a local copy.
  const res = await fetch(`${url.startsWith('http') ? '' : API_URL}${url}`, {
    headers: { Authorization: 'Bearer ' + (localStorage.getItem('gam_token') || '') },
  })
  if (!res.ok) { toast.error('Could not open that form'); return }
  window.open(URL.createObjectURL(await res.blob()), '_blank', 'noopener')
}

const edition = (d: string | null) => {
  if (!d) return null
  const [y, m, day] = d.slice(0, 10).split('-').map(Number)
  return new Date(y, m - 1, day).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
}

/**
 * Two places show the library, per Nic: "it can still be a separate tab for a
 * reference point and viewing, but... the library needs to also be already in
 * the templates so that they can check the boxes... In government forms [it's]
 * read only. Templates for the template editor."
 *
 *   mode 'templates' — under the landlord's own templates; Edit boxes opens the
 *                      template editor.
 *   mode 'reference' — the Government Forms tab; read only. Description,
 *                      publisher and source, and View. Nothing to change.
 */
export default function TemplateLibrarySection({ mode = 'templates', canEdit = false, onEditBoxes }: {
  mode?: 'templates' | 'reference'
  canEdit?: boolean
  onEditBoxes?: (templateId: string) => void
}) {
  const reference = mode === 'reference'
  const qc = useQueryClient()
  const { data, isLoading } = useLibrary()
  const [busy, setBusy] = useState<string | null>(null)
  const [open, setOpen] = useState<Record<string, boolean>>({})

  if (isLoading || !data) return null
  const docs = data.documents
  if (!docs.length) return null

  const groups = docs.reduce<Record<string, LibraryDoc[]>>((acc, d) => {
    ;(acc[d.jurisdiction] ||= []).push(d)
    return acc
  }, {})
  const order = Object.keys(groups).sort((a, b) =>
    a === 'US' ? -1 : b === 'US' ? 1 : jurisdictionLabel(a).localeCompare(jurisdictionLabel(b)))
  const isOpen = (j: string) => open[j] ?? (j === 'US' || data.operatingStates.includes(j))

  const editBoxes = async (d: LibraryDoc) => {
    setBusy(d.id)
    try {
      const templateId = d.adoptedTemplateId ?? await ensureLibraryCopy(d.id)
      qc.invalidateQueries('esign-library')
      onEditBoxes?.(templateId)
    } catch (e: any) {
      toast.error(e?.message || 'Could not open that form')
    } finally { setBusy(null) }
  }

  return (
    <div style={{ marginTop: reference ? 0 : 28 }}>
      {/* Nic: "landlord stuff's always at the top no matter the alphabet order
          and... there's a page break below their uploads and then the library."
          A real rule, not just spacing, so the two never read as one list. */}
      {!reference && <hr style={{ border: 'none', borderTop: '1px solid var(--border-1)', margin: '0 0 20px' }} />}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <Landmark size={16} style={{ color: 'var(--gold)' }} />
        <h2 style={{ margin: 0, fontSize: '1rem', color: 'var(--text-0)' }}>{reference ? 'Government Forms' : 'Library'}</h2>
      </div>
      <div style={{ fontSize: '.75rem', color: 'var(--text-3)', marginBottom: 12, maxWidth: 720, lineHeight: 1.45 }}>
        {reference
          ? 'Forms and pamphlets published by government agencies, kept exactly as issued — here for reference. Every one is also in your Templates, where you place its initial and signature boxes.'
          : 'Forms and pamphlets published by government agencies, kept exactly as issued. Add or move the initial and signature boxes on any of them. For different wording, upload your own form above.'}
      </div>

      {order.map(j => (
        <div key={j} className="card" style={{ padding: 0, marginBottom: 10, overflow: 'hidden' }}>
          <button onClick={() => setOpen({ ...open, [j]: !isOpen(j) })}
            style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px',
                     background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-1)',
                     fontSize: '.78rem', fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase' }}>
            {isOpen(j) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            {jurisdictionLabel(j)}
            <span style={{ fontWeight: 500, color: 'var(--text-3)', textTransform: 'none', letterSpacing: 0 }}>
              · {groups[j].length} {groups[j].length === 1 ? 'form' : 'forms'}
            </span>
          </button>
          {isOpen(j) && groups[j].map(d => {
            const ed = edition(d.effectiveFrom)
            return (
              <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
                                       padding: '9px 14px', borderTop: '1px solid var(--border-0)' }}>
                <div style={{ flex: '1 1 320px', minWidth: 0 }}>
                  <div style={{ fontWeight: 600, color: 'var(--text-0)', fontSize: '.86rem' }}>{d.name}</div>
                  <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginTop: 1 }}>
                    {d.publishedBy} · {d.pageCount} {d.pageCount === 1 ? 'page' : 'pages'}
                    {ed && <> · {ed}</>}
                    {!reference && d.fieldCount != null && <> · {d.fieldCount} boxes</>}
                  </div>
                  {reference && d.description && (
                    <div style={{ fontSize: '.75rem', color: 'var(--text-2)', marginTop: 4, lineHeight: 1.45 }}>{d.description}</div>
                  )}
                  {reference && d.sourceUrl && (
                    <div style={{ fontSize: '.68rem', marginTop: 3 }}>
                      <a href={d.sourceUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--text-3)' }}>
                        Source: {new URL(d.sourceUrl).hostname}
                      </a>
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button className="btn btn-primary btn-sm" onClick={() => openPdf(d.pdfUrl)}>
                    <Eye size={12} /> View
                  </button>
                  {!reference && canEdit && (
                    <button className="btn btn-primary btn-sm" disabled={busy === d.id} onClick={() => editBoxes(d)}>
                      <Settings size={12} /> {busy === d.id ? 'Opening…' : 'Edit boxes'}
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}
