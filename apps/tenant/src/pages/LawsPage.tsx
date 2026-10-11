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
type Home = { leaseId: string; state: string; propertyName: string; unitNumber: string; documents: LawDoc[] }

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

            {h.documents.length === 0 && (
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
