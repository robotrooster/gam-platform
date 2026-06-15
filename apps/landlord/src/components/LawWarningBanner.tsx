import { AlertTriangle, ExternalLink } from 'lucide-react'

/**
 * S477: factual hedged state-law warning banner.
 *
 * Renders a list of LawFlag objects returned by API write paths
 * (lease PATCH, entry-request POST, etc.) as amber banners with the
 * statute citation, source URL, and "may be out of date" disclaimer
 * inline. NEVER calls the warning "advice" or "compliance" — the
 * copy is the server's hedged factual statement; this component only
 * decorates it.
 *
 * Empty array = renders nothing. Safe to drop in unconditionally.
 */

export interface LawFlag {
  topic: string
  message: string
  citation: string | null
  sourceUrl: string | null
  sourceDate: string
  disclaimer: string
}

interface Props {
  warnings: LawFlag[] | undefined | null
  // Optional override title; otherwise uses "Heads up — state-law check"
  title?: string
}

export function LawWarningBanner({ warnings, title }: Props) {
  if (!warnings || warnings.length === 0) return null

  return (
    <div style={{
      background: 'rgba(245, 158, 11, 0.08)',
      border: '1px solid rgba(245, 158, 11, 0.4)',
      borderRadius: 8,
      padding: '12px 14px',
      marginBottom: 12,
      display: 'flex',
      gap: 10,
      alignItems: 'flex-start',
    }}>
      <AlertTriangle size={16} style={{ color: 'var(--amber, #f59e0b)', flexShrink: 0, marginTop: 2 }} />
      <div style={{ flex: 1, fontSize: 13, lineHeight: 1.5 }}>
        <div style={{
          fontWeight: 700,
          color: 'var(--amber, #f59e0b)',
          fontSize: 12,
          textTransform: 'uppercase',
          letterSpacing: 0.5,
          marginBottom: 6,
        }}>
          {title ?? 'Heads up — state-law check'}
        </div>
        {warnings.map((w, i) => (
          <div key={i} style={{ marginBottom: i < warnings.length - 1 ? 12 : 0 }}>
            <div style={{ color: 'var(--text-0)', marginBottom: 4 }}>
              {w.message}
            </div>
            <div style={{
              fontSize: 11,
              color: 'var(--text-3)',
              display: 'flex',
              flexWrap: 'wrap',
              gap: 8,
              marginTop: 4,
            }}>
              {w.citation && (
                <span>{w.citation}</span>
              )}
              {w.sourceUrl && (
                <a
                  href={w.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    color: 'var(--amber, #f59e0b)',
                    textDecoration: 'none',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 3,
                  }}
                >
                  source <ExternalLink size={10} />
                </a>
              )}
              <span>as of {w.sourceDate.slice(0, 10)}</span>
            </div>
            <div style={{
              fontSize: 10,
              color: 'var(--text-3)',
              fontStyle: 'italic',
              marginTop: 4,
              lineHeight: 1.45,
            }}>
              {w.disclaimer}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
