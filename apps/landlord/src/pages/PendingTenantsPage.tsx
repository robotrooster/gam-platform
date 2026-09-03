import { useState, useRef, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { useNavigate } from 'react-router-dom'
import {
  ArrowLeft, Upload, Eye, Trash2, AlertCircle, AlertTriangle, CheckCircle2,
  Loader, Inbox, X, Mail,
} from 'lucide-react'
import { api, apiGet, apiDelete, apiPatch } from '../lib/api'
import { loadPdfjs } from '../lib/pdfjs'
import { ConfirmIntentModal } from './ConfirmIntentModal'
import {
  PARSER_STATUS_META,
  PARSER_FLAG_CATEGORY_META,
  type ParserStatus,
  type ParserFlag,
} from '@gam/shared'

// ========== Response shape from GET /api/landlords/me/pending-tenants ==========
type PendingIntent = {
  intentId: string
  tenantId: string
  userId: string
  email: string
  firstName: string
  lastName: string
  phone: string | null
  parserStatus: ParserStatus
  importedPdfUrl: string | null
  parserOutput: any | null
  parserFlags: ParserFlag[] | null
  parserError: string | null
  parserStartedAt: string | null
  parserFinishedAt: string | null
  createdAt: string
  updatedAt: string
}

const API_URL = (import.meta as any).env?.VITE_API_URL || 'http://localhost:4000'

// Semantic colors not assumed to be in CSS vars. Inline hex for portability.
const COLOR_DANGER  = '#dc2626'
const COLOR_WARNING = '#f59e0b'
const COLOR_SUCCESS = '#16a34a'


// ========== Status badge using shared metadata ==========
function StatusBadge({ status }: { status: ParserStatus }) {
  const meta = PARSER_STATUS_META[status]
  return (
    <span className={`badge badge-${meta.tone}`} title={meta.description}>
      {meta.label}
    </span>
  )
}


// ========== PDF Viewer Modal — pattern lifted from tenant LeasePage ==========
// Note: pdf.js is loaded from CDN on demand. This is the 5th instance of
// this pattern in the monorepo (tenant LeasePage, tenant SignPage, landlord
// SignPage, landlord ESignPage, plus this). Extracting to a shared hook is
// deferred work — see deferred list.
function PdfViewerModal({ intentId, name, onClose }: {
  intentId: string
  name: string
  onClose: () => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(1)
  const [loadError, setLoadError] = useState<string | null>(null)
  const pdfRef = useRef<any>(null)
  const renderTaskRef = useRef<any>(null)
  const loadedRef = useRef(false)

  const url = `${API_URL}/api/landlords/me/pending-tenants/${intentId}/document`
  const token = localStorage.getItem('gam_token') || ''

  useEffect(() => {
    const load = async () => {
      if (loadedRef.current) return
      loadedRef.current = true
      try {
        const pdfjsLib = await loadPdfjs()
        const pdf = await pdfjsLib.getDocument({
          url,
          httpHeaders: { Authorization: 'Bearer ' + token },
        }).promise
        pdfRef.current = pdf
        setTotal(pdf.numPages)
        setTimeout(() => renderPage(pdf, 1), 100)
      } catch (e: any) {
        setLoadError(e?.message || 'Failed to load PDF')
      }
    }
    load()
    return () => {
      if (renderTaskRef.current) {
        try { renderTaskRef.current.cancel() } catch {}
      }
    }
  }, [url])

  const renderPage = async (pdf: any, pageNum: number) => {
    if (!canvasRef.current || !containerRef.current) return
    if (renderTaskRef.current) {
      try { renderTaskRef.current.cancel() } catch {}
      renderTaskRef.current = null
    }
    const p = await pdf.getPage(pageNum)
    const baseVp = p.getViewport({ scale: 1 })
    const scale = containerRef.current.clientWidth / baseVp.width
    const vp = p.getViewport({ scale })
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')!
    canvas.width = vp.width
    canvas.height = vp.height
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    const task = p.render({ canvasContext: ctx, viewport: vp })
    renderTaskRef.current = task
    try { await task.promise } catch (e: any) {
      if (e?.name !== 'RenderingCancelledException') console.error(e)
    }
  }

  const goPage = (n: number) => {
    setPage(n)
    if (pdfRef.current) renderPage(pdfRef.current, n)
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal"
        style={{ maxWidth: 880, maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="modal-title" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span>Lease document — {name}</span>
          <button onClick={onClose} className="btn btn-ghost btn-sm" aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div ref={containerRef} style={{ flex: 1, overflow: 'auto', padding: 12, background: 'var(--bg-2)' }}>
          {loadError ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-2)' }}>
              <AlertCircle size={24} style={{ color: COLOR_DANGER }} />
              <div style={{ marginTop: 8 }}>{loadError}</div>
            </div>
          ) : (
            <canvas ref={canvasRef} style={{ display: 'block', width: '100%' }} />
          )}
        </div>
        {total > 1 && !loadError && (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            gap: 12, padding: 10, borderTop: '1px solid var(--border-0)',
          }}>
            <button className="btn btn-ghost btn-sm" disabled={page === 1} onClick={() => goPage(page - 1)}>
              ← Prev
            </button>
            <span style={{ fontSize: '.78rem', color: 'var(--text-3)' }}>Page {page} of {total}</span>
            <button className="btn btn-ghost btn-sm" disabled={page === total} onClick={() => goPage(page + 1)}>
              Next →
            </button>
          </div>
        )}
      </div>
    </div>
  )
}


// ========== Delete Confirmation Modal ==========
function DeleteConfirmModal({ name, onCancel, onConfirm, busy }: {
  name: string
  onCancel: () => void
  onConfirm: () => void
  busy: boolean
}) {
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" style={{ maxWidth: 480 }} onClick={e => e.stopPropagation()}>
        <div className="modal-title">Cancel this invite?</div>
        {/* S636: this said cancelling "deletes the pending intent and any
            uploaded lease document". It does not, and has not since the
            hard-delete path was removed on purpose — the person, their document
            and this record all stay. What actually changes is the link, which is
            the part the landlord needs to know. */}
        <div style={{ padding: 16, fontSize: '.88rem', color: 'var(--text-1)', lineHeight: 1.5 }}>
          <p style={{ marginTop: 0 }}>
            <strong>{name}</strong>'s invite link stops working immediately, and any space
            being held for them is released.
          </p>
          <p style={{ marginBottom: 0, color: 'var(--text-2)' }}>
            Nothing is deleted — they and any document they sent stay on record. You can
            invite them again at any time. If the address is simply wrong,
            use <strong>Fix email</strong> instead: it keeps them on the same space and re-sends.
          </p>
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onCancel} disabled={busy}>Keep it</button>
          <button
            onClick={onConfirm}
            disabled={busy}
            className="btn"
            style={{ background: COLOR_DANGER, color: '#fff', borderColor: COLOR_DANGER }}
          >
            {busy ? 'Cancelling...' : 'Cancel invite'}
          </button>
        </div>
      </div>
    </div>
  )
}

// S636 (Nic): "It has the wrong email and I need to restart it."
//
// The route behind this has existed since S632 and nothing ever called it, so
// the only way to fix a mistyped address was to cancel and start over — losing
// the held space and any work-trade or screening state along with it. Correcting
// it in place keeps all of that and issues a fresh link.
function FixEmailModal({ name, current, value, onChange, error, busy, onCancel, onConfirm }: {
  name: string
  current: string
  value: string
  onChange: (v: string) => void
  error: string | null
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const changed = value.trim().length > 0 && value.trim().toLowerCase() !== current.toLowerCase()
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" style={{ maxWidth: 480 }} onClick={e => e.stopPropagation()}>
        <div className="modal-title">Send {name}'s invite somewhere else</div>
        <div style={{ padding: 16, fontSize: '.88rem', color: 'var(--text-1)', lineHeight: 1.5 }}>
          <p style={{ marginTop: 0, color: 'var(--text-2)' }}>
            Currently going to <strong style={{ color: 'var(--text-1)' }}>{current}</strong>.
          </p>
          <label style={{ fontSize: '.7rem', color: 'var(--text-3)', display: 'block', marginBottom: 4 }}>
            New email address
          </label>
          <input
            className="input" type="email" value={value} autoFocus
            onChange={e => onChange(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && changed && !busy) onConfirm() }}
            style={{ width: '100%' }}
          />
          <p style={{ marginBottom: 0, marginTop: 12, fontSize: '.78rem', color: 'var(--text-3)' }}>
            They keep their place in the queue and any space held for them. A fresh invite
            goes to the new address and the old link stops working.
          </p>
          {error && (
            <div style={{ marginTop: 10, color: COLOR_DANGER, fontSize: '.8rem' }}>{error}</div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="btn btn-primary" onClick={onConfirm} disabled={busy || !changed}>
            {busy ? 'Sending...' : 'Save and re-send'}
          </button>
        </div>
      </div>
    </div>
  )
}


// ========== Inline flag-resolution detail (renders parser_flags) ==========
function FlagsDetail({ intent }: { intent: PendingIntent }) {
  const flags = intent.parserFlags || []

  // Group by category, blockers first within each.
  const byCategory = flags.reduce<Record<string, ParserFlag[]>>((acc, f) => {
    if (!acc[f.category]) acc[f.category] = []
    acc[f.category].push(f)
    return acc
  }, {})
  Object.values(byCategory).forEach(arr => {
    arr.sort((a, b) => (a.severity === 'block' ? 0 : 1) - (b.severity === 'block' ? 0 : 1))
  })

  // Error state — surface parser_error directly.
  if (intent.parserStatus === 'error' && intent.parserError) {
    return (
      <div style={{ padding: 16, background: 'var(--bg-2)', borderRadius: 8, border: '1px solid var(--border-0)' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <AlertCircle size={18} style={{ color: COLOR_DANGER, flexShrink: 0, marginTop: 2 }} />
          <div>
            <div style={{ fontWeight: 600, fontSize: '.88rem', color: 'var(--text-0)', marginBottom: 4 }}>
              Parser error
            </div>
            <div style={{ fontSize: '.82rem', color: 'var(--text-2)', lineHeight: 1.5 }}>
              {intent.parserError}
            </div>
          </div>
        </div>
      </div>
    )
  }

  // Empty flags state — parsed cleanly, ready to build.
  if (flags.length === 0) {
    return (
      <div style={{ padding: 16, background: 'var(--bg-2)', borderRadius: 8, border: '1px solid var(--border-0)' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <CheckCircle2 size={18} style={{ color: COLOR_SUCCESS, flexShrink: 0, marginTop: 2 }} />
          <div>
            <div style={{ fontWeight: 600, fontSize: '.88rem', color: 'var(--text-0)', marginBottom: 4 }}>
              No issues to resolve
            </div>
            <div style={{ fontSize: '.82rem', color: 'var(--text-2)', lineHeight: 1.5 }}>
              The parser read the lease without flagging anything. Build the lease when ready.
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {Object.entries(byCategory).map(([cat, list]) => {
        const meta = PARSER_FLAG_CATEGORY_META[cat as keyof typeof PARSER_FLAG_CATEGORY_META]
        const hasBlocker = list.some(f => f.severity === 'block')
        return (
          <div key={cat} style={{
            padding: 12, background: 'var(--bg-2)', borderRadius: 8,
            border: `1px solid ${hasBlocker ? COLOR_DANGER : 'var(--border-0)'}`,
          }}>
            <div style={{ fontWeight: 600, fontSize: '.84rem', color: 'var(--text-0)', marginBottom: 4 }}>
              {meta?.label || cat}
            </div>
            <div style={{ fontSize: '.78rem', color: 'var(--text-3)', marginBottom: 10 }}>
              {meta?.description}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {list.map((f, i) => (
                <div key={i} style={{
                  padding: 8, background: 'var(--bg-1)', borderRadius: 6,
                  borderLeft: `3px solid ${f.severity === 'block' ? COLOR_DANGER : COLOR_WARNING}`,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                    {f.severity === 'block'
                      ? <AlertCircle size={12} style={{ color: COLOR_DANGER }} />
                      : <AlertTriangle size={12} style={{ color: COLOR_WARNING }} />}
                    <span style={{
                      fontSize: '.7rem', fontWeight: 600, color: 'var(--text-2)',
                      textTransform: 'uppercase', letterSpacing: '.04em',
                    }}>
                      {f.severity === 'block' ? 'Blocker' : 'Confirm'}
                    </span>
                    {f.field && (
                      <span style={{ fontSize: '.7rem', color: 'var(--text-3)', fontFamily: 'monospace' }}>
                        {f.field}
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: '.82rem', color: 'var(--text-1)', lineHeight: 1.4 }}>
                    {f.message}
                  </div>
                  {(f.expected || f.found) && (
                    <div style={{ marginTop: 6, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: '.78rem' }}>
                      {f.expected && (
                        <div>
                          <div style={{ color: 'var(--text-3)', marginBottom: 2 }}>You typed</div>
                          <div style={{ color: 'var(--text-0)', fontFamily: 'monospace', wordBreak: 'break-word' }}>{f.expected}</div>
                        </div>
                      )}
                      {f.found && (
                        <div>
                          <div style={{ color: 'var(--text-3)', marginBottom: 2 }}>Parser saw</div>
                          <div style={{ color: 'var(--text-0)', fontFamily: 'monospace', wordBreak: 'break-word' }}>{f.found}</div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}


// ========== Review modal (S534, Nic) ==========
// Flags and the DOCUMENT visible at the same time: parsed fields + flags
// in a left rail, the lease PDF on the right with highlight overlays
// drawn over every stretch of text the parser extracted a value from
// (gold = parsed clean, amber = flagged). Highlights are located by
// searching each page's pdf.js text layer for the field's rawText — the
// parser stores what it read, not where, so this is a text match; fields
// it NEVER found (field_missing flags) have nothing to highlight and are
// called out in the left rail instead.
type HighlightTarget = { path: string; label: string; raw: string; value: any; confidence: number; flagged: boolean }

const FIELD_LABELS: Record<string, string> = {
  firstName: 'First name', lastName: 'Last name', email: 'Email', phone: 'Phone',
  dateOfBirth: 'Date of birth', mailingAddress: 'Mailing address',
  propertyName: 'Property', unitNumber: 'Unit', propertyAddress: 'Property address', unitType: 'Unit type',
  leaseType: 'Lease type', leaseStart: 'Lease start', leaseEnd: 'Lease end',
  monthlyRent: 'Monthly rent', securityDeposit: 'Security deposit',
  lateFeeAmount: 'Late fee', lateFeeGraceDays: 'Late-fee grace days',
  autoRenew: 'Auto-renew', autoRenewMode: 'Auto-renew mode',
  noticeDaysRequired: 'Notice days', subleasingAllowed: 'Subleasing',
}

function collectTargets(intent: PendingIntent): HighlightTarget[] {
  const out: HighlightTarget[] = []
  const flags = intent.parserFlags || []
  const walk = (obj: any, prefix: string) => {
    if (!obj || typeof obj !== 'object') return
    for (const [key, v] of Object.entries(obj)) {
      if (v && typeof v === 'object' && 'value' in (v as any) && 'confidence' in (v as any)) {
        const f = v as any
        const path = `${prefix}.${key}`
        out.push({
          path, label: FIELD_LABELS[key] || key,
          raw: typeof f.rawText === 'string' ? f.rawText.trim() : '',
          value: f.value, confidence: Number(f.confidence) || 0,
          flagged: flags.some(fl => fl.field === path),
        })
      }
    }
  }
  const po = intent.parserOutput
  if (po) {
    walk(po.tenants?.[0], 'tenants.0')
    walk(po.unit, 'unit')
    walk(po.lease, 'lease')
  }
  return out
}

function ReviewIntentModal({ intent, onClose, onConfirm }: {
  intent: PendingIntent
  onClose: () => void
  onConfirm: () => void
}) {
  const pdfContainerRef = useRef<HTMLDivElement>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const targets = collectTargets(intent)
  const fullName = `${intent.firstName} ${intent.lastName}`.trim() || intent.email

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const pdfjsLib = await loadPdfjs()
        const pdf = await pdfjsLib.getDocument({
          url: `${API_URL}/api/landlords/me/pending-tenants/${intent.intentId}/document`,
          httpHeaders: { Authorization: 'Bearer ' + (localStorage.getItem('gam_token') || '') },
        }).promise
        if (cancelled || !pdfContainerRef.current) return
        const container = pdfContainerRef.current
        container.innerHTML = ''
        const width = container.clientWidth - 16
        for (let n = 1; n <= pdf.numPages; n++) {
          const p = await pdf.getPage(n)
          const base = p.getViewport({ scale: 1 })
          const scale = Math.min(width / base.width, 2)
          const vp = p.getViewport({ scale })
          const wrap = document.createElement('div')
          Object.assign(wrap.style, { position: 'relative', width: `${vp.width}px`, margin: '0 auto 12px' })
          const canvas = document.createElement('canvas')
          canvas.width = vp.width
          canvas.height = vp.height
          Object.assign(canvas.style, { display: 'block', background: '#fff', borderRadius: '6px' })
          wrap.appendChild(canvas)
          container.appendChild(wrap)
          await p.render({ canvasContext: canvas.getContext('2d')!, viewport: vp }).promise
          if (cancelled) return
          // Highlight overlays: any text item that appears inside a
          // target's rawText (or vice versa) gets that target's box.
          const tc = await p.getTextContent()
          for (const item of tc.items as any[]) {
            const s = (item.str || '').trim()
            if (s.length < 4) continue
            const hit = targets.find(t => t.raw.length >= 4 && (t.raw.includes(s) || s.includes(t.raw)))
            if (!hit) continue
            const [hx, hy] = vp.convertToViewportPoint(item.transform[4], item.transform[5])
            const h = (item.height || 10) * scale
            const w = (item.width || 40) * scale
            const el = document.createElement('div')
            el.title = `${hit.label}: ${hit.value}${hit.flagged ? ' — flagged, verify against the document' : ''}`
            Object.assign(el.style, {
              position: 'absolute', left: `${hx - 2}px`, top: `${hy - h - 3}px`,
              width: `${w + 5}px`, height: `${h + 6}px`, borderRadius: '3px',
              background: hit.flagged ? 'rgba(245,158,11,.30)' : 'rgba(201,162,39,.20)',
              border: `1.5px solid ${hit.flagged ? COLOR_WARNING : 'var(--gold, #c9a227)'}`,
            })
            wrap.appendChild(el)
          }
        }
      } catch (e: any) {
        if (!cancelled) setLoadError(e?.message || 'Failed to load the document')
      }
    }
    load()
    return () => { cancelled = true }
  }, [intent.intentId])

  const confDot = (c: number) => c >= 0.85 ? COLOR_SUCCESS : c >= 0.7 ? COLOR_WARNING : COLOR_DANGER

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 1180, width: '96vw', height: '90vh', display: 'flex', flexDirection: 'column' }} onClick={e => e.stopPropagation()}>
        <div className="modal-title" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span>Review parsed lease — {fullName}</span>
          <button onClick={onClose} className="btn btn-ghost btn-sm" aria-label="Close"><X size={16} /></button>
        </div>
        <div style={{ flex: 1, display: 'flex', gap: 14, minHeight: 0 }}>
          {/* Left rail: parsed fields + flags */}
          <div style={{ flex: '0 0 340px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12, paddingRight: 4 }}>
            <div style={{ fontSize: '.72rem', color: 'var(--text-3)', lineHeight: 1.5 }}>
              Highlights on the document show where each value was read —
              <span style={{ color: 'var(--gold, #c9a227)' }}> gold</span> parsed clean,
              <span style={{ color: COLOR_WARNING }}> amber</span> flagged. Hover a highlight for the field.
            </div>
            <div style={{ background: 'var(--bg-2)', borderRadius: 8, border: '1px solid var(--border-0)', padding: 12 }}>
              <div style={{ fontWeight: 600, fontSize: '.84rem', color: 'var(--text-0)', marginBottom: 8 }}>Parsed fields</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {targets.map(t => (
                  <div key={t.path} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '.78rem' }}>
                    <span title={`Confidence ${(t.confidence * 100).toFixed(0)}%`} style={{ width: 8, height: 8, borderRadius: '50%', background: confDot(t.confidence), flexShrink: 0 }} />
                    <span style={{ color: 'var(--text-3)', flex: '0 0 110px' }}>{t.label}</span>
                    <span style={{ color: 'var(--text-0)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{String(t.value)}</span>
                    {t.flagged && <AlertTriangle size={11} style={{ color: COLOR_WARNING, flexShrink: 0 }} />}
                  </div>
                ))}
                {targets.length === 0 && (
                  <div style={{ fontSize: '.78rem', color: 'var(--text-3)' }}>No parsed output stored for this intent.</div>
                )}
              </div>
            </div>
            <FlagsDetail intent={intent} />
          </div>
          {/* Right: document with highlights */}
          {/* S637: minHeight 0 — a flex child defaults to min-height:auto and will
              not shrink below its content, so overflow-y never engages and the
              bottom of the list sits unreachable past the container's cap. */}
          <div ref={pdfContainerRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto', background: 'var(--bg-2)', borderRadius: 10, padding: 8 }}>
            {loadError && (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-2)' }}>
                <AlertCircle size={20} style={{ color: COLOR_DANGER }} />
                <div style={{ marginTop: 8, fontSize: '.84rem' }}>{loadError}</div>
              </div>
            )}
          </div>
        </div>
        <div className="modal-footer" style={{ marginTop: 12 }}>
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
          <button className="btn btn-primary" onClick={onConfirm}>Confirm and Build Lease</button>
        </div>
      </div>
    </div>
  )
}


// ========== Single intent row ==========
function IntentCard({
  intent, onToggle, onUpload, onView, onDelete, onFixEmail, uploading,
}: {
  intent: PendingIntent
  onToggle: () => void
  onUpload: () => void
  onView: () => void
  onDelete: () => void
  onFixEmail: () => void
  uploading: boolean
}) {
  const fullName = `${intent.firstName} ${intent.lastName}`.trim() || '(no name)'
  const status = intent.parserStatus
  const isBusy = status === 'parsing' || uploading
  const canOpen = status === 'parsed' || status === 'mismatch'
  const canViewPdf = !!intent.importedPdfUrl && status !== 'parsing'
  const canReupload = status === 'error' || status === 'mismatch'

  return (
    <div style={{
      background: 'var(--bg-1)', border: '1px solid var(--border-0)',
      borderRadius: 10, padding: 16, opacity: isBusy ? 0.85 : 1,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
            <div style={{ fontWeight: 700, fontSize: '1rem', color: 'var(--text-0)' }}>{fullName}</div>
            <StatusBadge status={status} />
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, fontSize: '.8rem', color: 'var(--text-2)' }}>
            <span>{intent.email}</span>
            {intent.phone && <span>{intent.phone}</span>}
            {/* W-27 (S531): the spot held for them — excluded from guest
                booking until the intent resolves. */}
            {(intent as any).heldUnitNumber && (
              <span style={{ color: 'var(--gold)' }}>
                Holding Unit {(intent as any).heldUnitNumber}{(intent as any).heldPropertyName ? ` — ${(intent as any).heldPropertyName}` : ''}
              </span>
            )}
            <span style={{ color: 'var(--text-3)' }}>
              Added {new Date(intent.createdAt).toLocaleDateString()}
            </span>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {isBusy && (
            <Loader size={16} style={{ animation: 'spin 1s linear infinite', color: 'var(--text-3)' }} />
          )}
          {status === 'not_uploaded' && (
            <button onClick={onUpload} className="btn btn-primary btn-sm" disabled={uploading}>
              <Upload size={14} style={{ marginRight: 4 }} />
              Upload Document
            </button>
          )}
          {canReupload && (
            <button onClick={onUpload} className="btn btn-ghost btn-sm" disabled={uploading} title="Replace the uploaded PDF">
              <Upload size={14} style={{ marginRight: 4 }} />
              Re-upload
            </button>
          )}
          {canViewPdf && (
            <button onClick={onView} className="btn btn-ghost btn-sm" title="View the lease document">
              <Eye size={14} style={{ marginRight: 4 }} />
              View PDF
            </button>
          )}
          {canOpen && (
            // S534: opens the side-by-side review (flags + highlighted
            // document together) instead of the old inline expansion.
            <button onClick={onToggle} className="btn btn-primary btn-sm">
              <Eye size={14} style={{ marginRight: 4 }} />
              Review
            </button>
          )}
          {/* S636 (Nic): "I need to cancel an invite for mobile home 9. Can't
              see where to cancel pending, but it has the wrong email and I need
              to restart it."

              Two endpoints existed for exactly this and NEITHER had a control.
              Correcting the address is the better of the two — it keeps the same
              person on the same space and re-sends, where cancelling means
              re-inviting from scratch — so it goes first and says so. */}
          {!isBusy && (
            <button onClick={onFixEmail} className="btn btn-ghost btn-sm"
                    title="Send to a different address — keeps this person on the same space">
              <Mail size={14} style={{ marginRight: 4 }} />
              Fix email
            </button>
          )}
          {!isBusy && (
            <button onClick={onDelete} className="btn btn-ghost btn-sm"
                    title="Cancel this invite — their link stops working and the space is freed">
              <Trash2 size={14} style={{ marginRight: 4 }} />
              Cancel invite
            </button>
          )}
        </div>
      </div>

      {/* Inline error preview — landlord sees what went wrong without opening. */}
      {status === 'error' && intent.parserError && (
        <div style={{
          marginTop: 12, padding: 10, background: 'var(--bg-2)',
          borderLeft: `3px solid ${COLOR_DANGER}`, borderRadius: 6,
          fontSize: '.8rem', color: 'var(--text-2)',
        }}>
          {intent.parserError}
        </div>
      )}

    </div>
  )
}


// ========== Top-level page ==========
export function PendingTenantsPage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [reviewIntentId, setReviewIntentId] = useState<string | null>(null)
  const [viewingPdf, setViewingPdf] = useState<{ intentId: string; name: string } | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<PendingIntent | null>(null)
  // S636: correct a mistyped invite address and re-send, without losing the
  // person or the space they are held on.
  const [fixTarget, setFixTarget] = useState<PendingIntent | null>(null)
  const [fixEmail, setFixEmail] = useState('')
  const [fixError, setFixError] = useState<string | null>(null)
  const [fixDone, setFixDone] = useState<string | null>(null)
  const [uploadingId, setUploadingId] = useState<string | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [pendingUploadId, setPendingUploadId] = useState<string | null>(null)
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const [resolvedToast, setResolvedToast] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // List with stop-when-idle polling. refetchInterval returns false when no
  // row is parsing — react-query then idles until something else invalidates.
  const { data: intents = [], isLoading, error } = useQuery<PendingIntent[]>(
    'pending-tenants',
    () => apiGet<PendingIntent[]>('/landlords/me/pending-tenants'),
    {
      refetchInterval: (data) => {
        if (!Array.isArray(data)) return false
        return data.some(d => d.parserStatus === 'parsing') ? 5000 : false
      },
      refetchOnWindowFocus: false,
    }
  )

  const deleteMut = useMutation(
    (intentId: string) => apiDelete(`/landlords/me/pending-tenants/${intentId}`),
    {
      onSuccess: () => {
        qc.invalidateQueries('pending-tenants')
        qc.invalidateQueries('pending-tenants-count')
        setDeleteTarget(null)
        if (reviewIntentId === deleteTarget?.intentId) setReviewIntentId(null)
      },
      onError: (e: any) => {
        setUploadError(e?.response?.data?.message || 'Delete failed')
      },
    }
  )

  const fixEmailMut = useMutation(
    (v: { intentId: string; email: string }) =>
      apiPatch(`/landlords/me/pending-intents/${v.intentId}/contact`,
               { email: v.email, resend: true }),
    {
      onSuccess: (_d, v) => {
        qc.invalidateQueries('pending-tenants')
        qc.invalidateQueries('pending-tenants-count')
        setFixDone(`Invite re-sent to ${v.email}`)
        setFixTarget(null)
        setTimeout(() => setFixDone(null), 6000)
      },
      onError: (e: any) => setFixError(
        e?.response?.data?.error || 'Could not update the address'),
    }
  )

  // Upload — manual call through the axios instance with multipart override.
  // The instance has Content-Type: application/json set as a default, which
  // would prevent boundary detection on FormData. Explicit override fixes that.
  const handleFilePick = (intentId: string) => {
    setPendingUploadId(intentId)
    setUploadError(null)
    fileInputRef.current?.click()
  }

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    const intentId = pendingUploadId
    e.target.value = '' // allow re-pick of same file
    if (!file || !intentId) return

    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      setUploadError('File must be a PDF.')
      return
    }
    if (file.size > 20 * 1024 * 1024) {
      setUploadError('File exceeds the 20 MB limit.')
      return
    }

    setUploadingId(intentId)
    try {
      const fd = new FormData()
      fd.append('file', file)
      await api.post(
        `/landlords/me/pending-tenants/${intentId}/document`,
        fd,
        { headers: { 'Content-Type': 'multipart/form-data' } }
      )
      qc.invalidateQueries('pending-tenants')
      qc.invalidateQueries('pending-tenants-count')
    } catch (err: any) {
      setUploadError(err?.response?.data?.message || 'Upload failed')
    } finally {
      setUploadingId(null)
      setPendingUploadId(null)
    }
  }

  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: '0 auto' }}>
      <button
        onClick={() => navigate('/tenant-onboarding')}
        className="btn btn-ghost"
        style={{ marginBottom: 16, display: 'inline-flex', alignItems: 'center', gap: 6 }}
      >
        <ArrowLeft size={14} />
        Back to onboarding
      </button>

      <div style={{ marginBottom: 20, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <h1 style={{ fontSize: '1.6rem', fontWeight: 700, color: 'var(--text-0)', margin: 0 }}>
            Pending Pool
          </h1>
          <p style={{ fontSize: '.88rem', color: 'var(--text-2)', marginTop: 6, lineHeight: 1.5 }}>
            Tenants waiting on a lease document. Upload PDFs to complete onboarding.
          </p>
        </div>
        <div style={{ fontSize: '.82rem', color: 'var(--text-3)' }}>
          {intents.length} pending
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="application/pdf"
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />

      {uploadError && (
        <div style={{
          padding: 12, marginBottom: 16, background: 'var(--bg-2)',
          borderLeft: `3px solid ${COLOR_DANGER}`, borderRadius: 6,
          fontSize: '.84rem', color: 'var(--text-1)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <AlertCircle size={16} style={{ color: COLOR_DANGER }} />
            <span>{uploadError}</span>
          </div>
          <button onClick={() => setUploadError(null)} className="btn btn-ghost btn-sm">
            <X size={14} />
          </button>
        </div>
      )}

      {isLoading ? (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-3)' }}>
          <Loader size={20} style={{ animation: 'spin 1s linear infinite' }} />
          <div style={{ marginTop: 8, fontSize: '.84rem' }}>Loading pending pool...</div>
        </div>
      ) : error ? (
        <div style={{
          padding: 24, background: 'var(--bg-1)', borderRadius: 10,
          border: `1px solid ${COLOR_DANGER}`, color: 'var(--text-1)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <AlertCircle size={16} style={{ color: COLOR_DANGER }} />
            <strong>Failed to load pending pool</strong>
          </div>
          <div style={{ fontSize: '.84rem', color: 'var(--text-2)' }}>
            {(error as any)?.response?.data?.message || 'Try refreshing the page.'}
          </div>
        </div>
      ) : intents.length === 0 ? (
        <div style={{
          padding: 40, textAlign: 'center', background: 'var(--bg-1)',
          borderRadius: 10, border: '1px dashed var(--border-0)',
        }}>
          <Inbox size={32} style={{ color: 'var(--text-3)', marginBottom: 12 }} />
          <div style={{ fontWeight: 600, fontSize: '1rem', color: 'var(--text-0)', marginBottom: 6 }}>
            Pending pool is empty
          </div>
          <div style={{ fontSize: '.84rem', color: 'var(--text-2)', maxWidth: 480, margin: '0 auto', lineHeight: 1.5 }}>
            When you add a single tenant or import a CSV with rows missing lease data,
            those tenants land here waiting for their lease PDF.
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {intents.map(intent => (
            <IntentCard
              key={intent.intentId}
              intent={intent}
              onToggle={() => setReviewIntentId(intent.intentId)}
              onUpload={() => handleFilePick(intent.intentId)}
              onView={() => setViewingPdf({
                intentId: intent.intentId,
                name: `${intent.firstName} ${intent.lastName}`.trim() || intent.email,
              })}
              onDelete={() => setDeleteTarget(intent)}
              onFixEmail={() => { setFixTarget(intent); setFixEmail(intent.email); setFixError(null) }}
              uploading={uploadingId === intent.intentId}
            />
          ))}
        </div>
      )}

      {viewingPdf && (
        <PdfViewerModal
          intentId={viewingPdf.intentId}
          name={viewingPdf.name}
          onClose={() => setViewingPdf(null)}
        />
      )}
      {reviewIntentId && (() => {
        const ri = intents.find(i => i.intentId === reviewIntentId)
        return ri ? (
          <ReviewIntentModal
            intent={ri}
            onClose={() => setReviewIntentId(null)}
            onConfirm={() => { setReviewIntentId(null); setConfirmingId(ri.intentId) }}
          />
        ) : null
      })()}
      {confirmingId && (
        <ConfirmIntentModal
          intentId={confirmingId}
          onClose={() => setConfirmingId(null)}
          onResolved={(result: { leaseId: string; tenantId: string; userId: string; email: string; activationUrl: string }) => {
            setConfirmingId(null)
            setReviewIntentId(null)
            setResolvedToast(`Lease built for ${result.email}.`)
            qc.invalidateQueries('pending-tenants')
            qc.invalidateQueries('pending-tenants-count')
            qc.invalidateQueries('leases')
            setTimeout(() => setResolvedToast(null), 6000)
          }}
        />
      )}
      {resolvedToast && (
        <div style={{
          position: 'fixed', bottom: 24, right: 24, zIndex: 9999,
          padding: '10px 14px', background: 'var(--bg-1)',
          border: `1px solid ${COLOR_SUCCESS}`, borderLeft: `3px solid ${COLOR_SUCCESS}`,
          borderRadius: 6, fontSize: '.84rem', color: 'var(--text-0)',
          boxShadow: '0 6px 20px rgba(0,0,0,.18)',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <CheckCircle2 size={16} style={{ color: COLOR_SUCCESS }} />
          {resolvedToast}
        </div>
      )}
      {fixDone && (
        <div style={{
          position: 'fixed', bottom: 24, right: 24, zIndex: 60,
          background: 'var(--bg-1)', border: '1px solid var(--border-0)',
          borderRadius: 10, padding: '12px 16px', fontSize: '.85rem',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <CheckCircle2 size={16} style={{ color: COLOR_SUCCESS }} />
          {fixDone}
        </div>
      )}
      {fixTarget && (
        <FixEmailModal
          name={`${fixTarget.firstName} ${fixTarget.lastName}`.trim() || fixTarget.email}
          current={fixTarget.email}
          value={fixEmail}
          onChange={setFixEmail}
          error={fixError}
          busy={fixEmailMut.isLoading}
          onCancel={() => { setFixTarget(null); setFixError(null) }}
          onConfirm={() => {
            setFixError(null)
            fixEmailMut.mutate({ intentId: fixTarget.intentId, email: fixEmail.trim() })
          }}
        />
      )}
      {deleteTarget && (
        <DeleteConfirmModal
          name={`${deleteTarget.firstName} ${deleteTarget.lastName}`.trim() || deleteTarget.email}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => deleteMut.mutate(deleteTarget.intentId)}
          busy={deleteMut.isLoading}
        />
      )}
    </div>
  )
}
