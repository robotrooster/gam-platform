import { useState } from 'react'
import { useQuery } from 'react-query'
import { apiGet } from '../lib/api'
import { Scale, BookOpen, FileText } from 'lucide-react'
import { US_STATE_NAME } from '@gam/shared'

const API_URL = (import.meta as any).env?.VITE_API_URL || 'http://localhost:4000'

/**
 * S652 — THE LAW FOR YOUR HOME.
 *
 * Nic: "the applicable Landlord Tenant Act shows up in the tenant's portal as a
 * side menu option... show the version so that it can be updated when we update
 * it. That should be accessible automatically to all tenants based on how the
 * unit type is set up."
 *
 * One section per home the tenant has a lease on: the state's landlord-tenant
 * act for that kind of space, as the state agency prints it, then the state's
 * plain-language guides. Every document names who published it and which
 * edition it is. They come from GAM's government library, so a new edition
 * reaches every tenant as soon as it is shelved.
 */
type LawDoc = {
  id: string; name: string; description: string | null; kind: 'act' | 'guide'
  publishedBy: string; edition: string | null; effectiveFrom: string | null
  pdfUrl: string; pageCount: number
}
type ActSection = { number: string; title: string | null }
type Act = { actKey: string; sectionCount: number; effectiveYear: number; sections: ActSection[] }
type Home = { leaseId: string; state: string; propertyName: string; unitNumber: string; documents: LawDoc[]; act: Act | null }

async function openPdf(url: string) {
  // The file needs the sign-in, which a plain link cannot carry.
  const res = await fetch(`${url.startsWith('http') ? '' : API_URL}${url}`, {
    headers: { Authorization: `Bearer ${localStorage.getItem('gam_tenant_token') || ''}` },
  })
  if (!res.ok) return
  window.open(URL.createObjectURL(await res.blob()), '_blank', 'noopener')
}

// Strip the "Arizona: " in front — the section already says which state.
const short = (name: string) => name.replace(/^[A-Z][A-Za-z .]+:\s+/, '')

/** One section of the act — the text is fetched only when it is opened, so a
 *  fifty-section act is a list and not a megabyte. */
function LawSection({ state, actKey, sec }: { state: string; actKey: string; sec: { number: string; title: string | null } }) {
  const [open, setOpen] = useState(false)
  const { data, isLoading } = useQuery<{ sectionTitle: string | null; fullText: string; sourceUrl: string | null }>(
    ['law-section', state, actKey, sec.number],
    () => apiGet(`/tenants/me/laws/${state}/${encodeURIComponent(actKey)}/section?number=${encodeURIComponent(sec.number)}`),
    { enabled: open },
  )
  return (
    <div style={{ borderTop: '1px solid var(--b1, var(--border-0))' }}>
      <button
        onClick={() => setOpen(v => !v)}
        style={{ display: 'flex', gap: 10, alignItems: 'flex-start', width: '100%', textAlign: 'left',
                 background: 'none', border: 'none', padding: '10px 0', color: 'var(--t0)' }}>
        <Scale size={14} style={{ color: 'var(--gold)', flexShrink: 0, marginTop: 3 }} />
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ fontWeight: 600, fontSize: '.85rem' }}>{sec.number}</span>
          {sec.title && <span style={{ color: 'var(--t2)', fontSize: '.82rem' }}> — {sec.title}</span>}
        </span>
      </button>
      {open && (
        <div style={{ fontSize: '.8rem', color: 'var(--t2)', lineHeight: 1.6, padding: '0 0 12px 24px', whiteSpace: 'pre-wrap' }}>
          {isLoading ? 'Loading…' : (data?.fullText ?? 'Not available.')}
        </div>
      )}
    </div>
  )
}

export function LawsPage() {
  const { data, isLoading } = useQuery<Home[]>('tenant-laws', () => apiGet<Home[]>('/tenants/me/laws'))

  return (
    <div style={{ maxWidth: 780 }}>
      <div className="ph">
        <div className="pt" style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Scale size={20} /> Landlord-Tenant Act</div>
      </div>
      <p style={{ fontSize: '.85rem', color: 'var(--t2)', lineHeight: 1.55, margin: '0 0 18px' }}>
        The law that covers your home, as your state publishes it, and plain-language guides from state agencies.
        Each one shows which edition it is.
      </p>

      {isLoading && <div style={{ color: 'var(--t3)', fontSize: '.85rem' }}>Loading…</div>}

      {data && data.length === 0 && (
        <div className="card" style={{ padding: 18, fontSize: '.85rem', color: 'var(--t2)' }}>
          This page fills in once you have a lease through GAM.
        </div>
      )}

      {(data ?? []).map(h => {
        const acts = h.documents.filter(d => d.kind === 'act')
        const guides = h.documents.filter(d => d.kind === 'guide')
        const state = US_STATE_NAME[h.state] ?? h.state
        return (
          <div key={h.leaseId} className="card" style={{ padding: 18, marginBottom: 16 }}>
            <div style={{ fontWeight: 700, color: 'var(--t0)', marginBottom: 2 }}>{h.propertyName}{h.unitNumber ? ` · ${h.unitNumber}` : ''}</div>
            <div style={{ fontSize: '.75rem', color: 'var(--t3)', marginBottom: 14 }}>{state}</div>

            {/* 10/30 (Nic): "we have every Landlord-Tenant Act for every type
                of unit across the United States" — and we do, as statute TEXT
                for all fifty states. This page used to read only the PDF shelf,
                which holds two states, and told everyone else their state was
                missing. The text is the fallback, so no resident is ever told
                their own law does not exist. */}
            {h.act && h.act.sections.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: '.68rem', fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--t3)', marginBottom: 6 }}>
                  {acts.length > 0 ? 'Section by section' : 'The law'}
                </div>
                <div style={{ fontSize: '.75rem', color: 'var(--t3)', marginBottom: 8 }}>
                  {h.act.sectionCount} sections · {state} · {h.act.effectiveYear}
                </div>
                {h.act.sections.map(sec => (
                  <LawSection key={sec.number} state={h.state} actKey={h.act!.actKey} sec={sec} />
                ))}
              </div>
            )}

            {h.documents.length === 0 && !(h.act && h.act.sections.length > 0) && (
              <div style={{ fontSize: '.82rem', color: 'var(--t2)' }}>
                GAM doesn't have {state}'s landlord-tenant act in its library yet.
              </div>
            )}

            {[['The law', acts, Scale], ['Guides', guides, BookOpen]].map(([label, docs, Icon]: any) => docs.length > 0 && (
              <div key={label} style={{ marginBottom: 12 }}>
                <div style={{ fontSize: '.68rem', fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--t3)', marginBottom: 6 }}>{label}</div>
                {docs.map((d: LawDoc) => (
                  <div key={d.id} style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: '10px 0', borderTop: '1px solid var(--b1, var(--border-0))' }}>
                    <Icon size={16} style={{ color: 'var(--gold)', flexShrink: 0, marginTop: 2 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, color: 'var(--t0)', fontSize: '.88rem' }}>{short(d.name)}</div>
                      <div style={{ fontSize: '.72rem', color: 'var(--t3)', marginTop: 2 }}>
                        {d.publishedBy}{d.edition ? ` · ${d.edition.replace(/\s*\(via web\.archive\.org[^)]*\)/, '')}` : ''} · {d.pageCount} pages
                      </div>
                      {d.description && <div style={{ fontSize: '.78rem', color: 'var(--t2)', marginTop: 4, lineHeight: 1.45 }}>{d.description}</div>}
                    </div>
                    <button className="btn btn-primary" style={{ flexShrink: 0 }} onClick={() => openPdf(d.pdfUrl)}>
                      <FileText size={14} /> Read
                    </button>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )
      })}
    </div>
  )
}
