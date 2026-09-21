import { useQuery, useMutation, useQueryClient } from 'react-query'
import { apiGet, apiPost } from '../lib/api'
import { toast } from '../components/dialogs'
import { US_STATE_NAME } from '@gam/shared'
import { Landmark, Eye, Plus, Settings, Check } from 'lucide-react'

const API_URL = (import.meta as any).env?.VITE_API_URL || 'http://localhost:4000'

/**
 * S652 — the shelf of government-published forms.
 *
 * Nic: "the library should only be government published documents that
 * something we're not altering at all." Every form here is the agency's own
 * file. The landlord sees the ones published for the United States and for the
 * states they actually hold property in, narrowed to the kinds of space they run.
 *
 * WHAT THIS SCREEN NEVER SAYS: that anything is required. Nic: "we don't want to
 * show what the statute asks for because a landlord may have properties in
 * multiple states. We don't want to clutter all that screen." Whether a form
 * applies to them is their call; this only puts it within reach.
 *
 * Adding one makes an ordinary template, so it goes in packets and signs like
 * anything else. Its wording is fixed; its initial and signature boxes are the
 * landlord's to add, move or remove — an initial on the page is how delivery
 * gets proven.
 */
type LibraryDoc = {
  id: string
  name: string
  description: string | null
  disclosureLabel: string
  jurisdiction: string
  publishedBy: string
  publicationRef: string | null
  pdfUrl: string
  pageCount: number
  effectiveFrom: string | null
  adoptedTemplateId: string | null
}

const groupLabel = (j: string) => (j === 'US' ? 'Federal' : US_STATE_NAME[j] ?? j)

// The file route needs the login, and a plain link cannot carry it — so the PDF
// is fetched with the token and handed to a new tab as a local copy.
async function openPdf(url: string) {
  const res = await fetch(`${url.startsWith('http') ? '' : API_URL}${url}`, {
    headers: { Authorization: 'Bearer ' + (localStorage.getItem('gam_token') || '') },
  })
  if (!res.ok) { toast.error('Could not open that form'); return }
  const blob = await res.blob()
  window.open(URL.createObjectURL(blob), '_blank', 'noopener')
}

const fmtDate = (d: string | null) => {
  if (!d) return null
  const [y, m, day] = d.slice(0, 10).split('-').map(Number)
  return new Date(y, m - 1, day).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
}

export default function GovernmentFormsPanel({ onEditBoxes }: { onEditBoxes: (templateId: string) => void }) {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery<{ documents: LibraryDoc[] }>(
    'esign-library', () => apiGet<{ documents: LibraryDoc[] }>('/esign/library'))
  const docs = data?.documents ?? []

  const adopt = useMutation(
    (documentId: string) => apiPost<{ templateId: string; alreadyHeld: boolean }>('/esign/library/adopt', { documentId }),
    {
      onSuccess: () => {
        qc.invalidateQueries('esign-library')
        qc.invalidateQueries('esign-templates')
        qc.invalidateQueries('esign-templates-all')
        toast('Added to your templates. Initial and signature boxes are already placed — adjust them any time.')
      },
      onError: (e: any) => toast.error(e?.message || 'Could not add that form'),
    })

  if (isLoading) return <div className="card" style={{ padding: 24, color: 'var(--text-3)' }}>Loading forms…</div>

  const groups = docs.reduce<Record<string, LibraryDoc[]>>((acc, d) => {
    ;(acc[d.jurisdiction] ||= []).push(d)
    return acc
  }, {})
  // Federal first, then states alphabetically by name.
  const order = Object.keys(groups).sort((a, b) =>
    a === 'US' ? -1 : b === 'US' ? 1 : groupLabel(a).localeCompare(groupLabel(b)))

  return (
    <div>
      <div className="card" style={{ padding: '14px 18px', marginBottom: 18, display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <Landmark size={18} style={{ color: 'var(--gold)', flexShrink: 0, marginTop: 2 }} />
        <div style={{ fontSize: '.82rem', color: 'var(--text-2)', lineHeight: 1.5 }}>
          Forms and pamphlets published by government agencies, for the places you operate. GAM keeps each one
          exactly as the agency issued it. Add one to your templates to send it for signature — the initial and
          signature boxes come already placed, and you can add or move them. Need different wording? Upload your
          own form as a template instead.
        </div>
      </div>

      {docs.length === 0 && (
        <div className="card" style={{ padding: 24, color: 'var(--text-3)', fontSize: '.85rem' }}>
          No government forms for the places you operate yet.
        </div>
      )}

      {order.map(j => (
        <div key={j} style={{ marginBottom: 22 }}>
          <div style={{ fontSize: '.72rem', fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase',
                        color: 'var(--text-3)', marginBottom: 10 }}>
            {groupLabel(j)}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
            {groups[j].map(d => {
              const issued = fmtDate(d.effectiveFrom)
              return (
                <div key={d.id} className="card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ fontWeight: 600, color: 'var(--text-0)', lineHeight: 1.35 }}>{d.name}</div>
                  <div style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>
                    {d.publishedBy}
                    {' · '}{d.pageCount} {d.pageCount === 1 ? 'page' : 'pages'}
                    {issued && <>{' · '}{issued}</>}
                  </div>
                  {d.description && <div style={{ fontSize: '.78rem', color: 'var(--text-2)', lineHeight: 1.45 }}>{d.description}</div>}
                  <div style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>{d.disclosureLabel}</div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 'auto', paddingTop: 6 }}>
                    <button className="btn btn-primary btn-sm" onClick={() => openPdf(d.pdfUrl)}>
                      <Eye size={12} /> View
                    </button>
                    {d.adoptedTemplateId ? (
                      <>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '.75rem',
                                       color: 'var(--green, #3fb950)', padding: '0 6px' }}>
                          <Check size={13} /> In your templates
                        </span>
                        <button className="btn btn-primary btn-sm" onClick={() => onEditBoxes(d.adoptedTemplateId!)}>
                          <Settings size={12} /> Edit boxes
                        </button>
                      </>
                    ) : (
                      <button className="btn btn-primary btn-sm" disabled={adopt.isLoading}
                              onClick={() => adopt.mutate(d.id)}>
                        <Plus size={12} /> Add to my templates
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}
