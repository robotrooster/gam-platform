import { useState, useRef, useEffect, useMemo } from 'react'
import { X, AlertCircle, AlertTriangle, CheckCircle2, Loader } from 'lucide-react'
import { api, apiGet } from '../lib/api'
import {
  AUTO_RENEW_MODES,
  LEASE_TYPES,
  PARSER_FLAG_CATEGORY_META,
  SUBLEASING_POLICIES,
  UNIT_TYPES,
  type ParserFlag,
  type ParserOutput,
  type ParserStatus,
} from '@gam/shared'
import {
  type EntityArraySectionId,
  type EntityObjectSectionId,
  type EntitySectionId,
  SECTION_META,
  asOverrideField,
  freshRow,
  EntityArraySection,
  EntityObjectSection,
  UndoToast,
} from './ConfirmIntentModal.entities'

const API_URL = (import.meta as any).env?.VITE_API_URL || 'http://localhost:4000'

const COLOR_DANGER  = '#dc2626'
const COLOR_WARNING = '#f59e0b'
const COLOR_SUCCESS = '#16a34a'
const COLOR_MUTED   = '#9ca3af'

// ========== Types ==========

type IntentDetail = {
  intentId: string
  tenantId: string
  userId: string
  email: string
  firstName: string
  lastName: string
  phone: string | null
  parserStatus: ParserStatus
  parserOutput: ParserOutput | null
  parserFlags: ParserFlag[] | null
  parserError: string | null
  importedPdfUrl: string | null
}

type OverridesMap = Record<string, string | number | boolean>

type ResolveResponseData = {
  leaseId: string
  tenantId: string
  userId: string
  email: string
  activationUrl: string
}


// ========== Helpers ==========

function fieldAt(parsed: any, path: string): any {
  const parts = path.split('.')
  let cur = parsed
  for (const p of parts) {
    if (cur == null) return undefined
    cur = cur[p]
  }
  return cur
}

function materializeOverrides(map: OverridesMap): any {
  const out: any = {}
  for (const [path, value] of Object.entries(map)) {
    if (value === '' || value === undefined || value === null) continue
    const parts = path.split('.')
    let cur = out
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts[i]
      const nextKey = parts[i + 1]
      const isArrayIdx = /^\d+$/.test(nextKey)
      if (cur[key] === undefined) {
        cur[key] = isArrayIdx ? [] : {}
      } else if (isArrayIdx && !Array.isArray(cur[key])) {
        cur[key] = []
      }
      if (isArrayIdx) {
        const idx = parseInt(nextKey, 10)
        while (cur[key].length <= idx) cur[key].push({})
      }
      cur = cur[key]
    }
    const last = parts[parts.length - 1]
    cur[last] = {
      value,
      confidence: 1.0,
      rawText: '(landlord override)',
    }
  }
  return out
}

function tierOf(field: any): 'high' | 'mid' | 'low' | 'missing' {
  if (!field) return 'missing'
  const c = field.confidence ?? 0
  if (c >= 0.95) return 'high'
  if (c >= 0.70) return 'mid'
  return 'low'
}

function tierColor(t: 'high' | 'mid' | 'low' | 'missing'): string {
  switch (t) {
    case 'high':    return COLOR_SUCCESS
    case 'mid':     return COLOR_WARNING
    case 'low':     return COLOR_DANGER
    case 'missing': return COLOR_MUTED
  }
}


// ========== PDF Panel — embedded loader (6th instance) ==========

function PdfPanel({ intentId }: { intentId: string }) {
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
        if (!(window as any).pdfjsLib) {
          await new Promise<void>((resolve, reject) => {
            const s = document.createElement('script')
            s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js'
            s.onload = () => {
              ;(window as any).pdfjsLib.GlobalWorkerOptions.workerSrc =
                'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'
              resolve()
            }
            s.onerror = () => reject(new Error('Failed to load pdf.js from CDN'))
            document.head.appendChild(s)
          })
        }
        const pdf = await (window as any).pdfjsLib.getDocument({
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
    <div style={{
      display: 'flex', flexDirection: 'column',
      background: 'var(--bg-2)', borderRight: '1px solid var(--border-0)',
      height: '100%', overflow: 'hidden',
    }}>
      <div ref={containerRef} style={{ flex: 1, overflow: 'auto', padding: 12 }}>
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
          gap: 12, padding: 8, borderTop: '1px solid var(--border-0)',
        }}>
          <button className="btn btn-ghost btn-sm" disabled={page === 1} onClick={() => goPage(page - 1)}>
            ← Prev
          </button>
          <span style={{ fontSize: '.78rem', color: 'var(--text-3)' }}>
            Page {page} of {total}
          </span>
          <button className="btn btn-ghost btn-sm" disabled={page === total} onClick={() => goPage(page + 1)}>
            Next →
          </button>
        </div>
      )}
    </div>
  )
}


// ========== FieldRow ==========

type FieldRowProps = {
  label: string
  parsed: any
  override: string | number | boolean | undefined
  onEdit: (v: string | number | boolean | undefined) => void
  type?: 'text' | 'number' | 'date' | 'email' | 'tel' | 'select' | 'checkbox'
  options?: { value: string; label: string }[]
  hint?: string
}

function FieldRow({ label, parsed, override, onEdit, type = 'text', options, hint }: FieldRowProps) {
  const tier = tierOf(parsed)
  const dot = tierColor(tier)
  const parsedValue = parsed?.value
  const rawText = parsed?.rawText
  const conf = parsed?.confidence
  const isOverridden = override !== undefined && override !== parsedValue
  const currentValue: any = override !== undefined ? override : (parsedValue ?? (type === 'checkbox' ? false : ''))

  const inputBorder = tier === 'low' ? COLOR_DANGER : (isOverridden ? 'var(--text-2)' : 'var(--border-0)')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span title={tier} style={{
          width: 8, height: 8, borderRadius: '50%', background: dot, flexShrink: 0,
        }} />
        <label style={{ fontSize: '.78rem', color: 'var(--text-2)', fontWeight: 500 }}>{label}</label>
        {conf !== undefined && (
          <span style={{ fontSize: '.68rem', color: 'var(--text-3)' }}>
            {Math.round(conf * 100)}%
          </span>
        )}
        {isOverridden && (
          <span style={{
            fontSize: '.66rem', color: 'var(--text-2)',
            padding: '1px 6px', borderRadius: 3, background: 'var(--bg-2)',
            fontStyle: 'italic',
          }}>
            edited
          </span>
        )}
        {isOverridden && (
          <button
            onClick={() => onEdit(undefined)}
            className="btn btn-ghost btn-sm"
            style={{ marginLeft: 'auto', padding: '0 6px', fontSize: '.7rem' }}
            title="Revert to parsed value"
          >
            revert
          </button>
        )}
      </div>

      {type === 'select' && options ? (
        <select
          value={String(currentValue ?? '')}
          onChange={e => onEdit(e.target.value || undefined)}
          style={{
            padding: '6px 8px', fontSize: '.85rem',
            border: `1px solid ${inputBorder}`, borderRadius: 4,
            background: 'var(--bg-1)', color: 'var(--text-0)',
          }}
        >
          <option value="">—</option>
          {options.map(o => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      ) : type === 'checkbox' ? (
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '.85rem', color: 'var(--text-1)' }}>
          <input
            type="checkbox"
            checked={Boolean(currentValue)}
            onChange={e => onEdit(e.target.checked)}
          />
          {currentValue ? 'Yes' : 'No'}
        </label>
      ) : (
        <input
          type={type}
          value={currentValue == null ? '' : String(currentValue)}
          onChange={e => {
            const v = e.target.value
            if (type === 'number') {
              if (v === '') onEdit(undefined)
              else {
                const n = Number(v)
                onEdit(Number.isFinite(n) ? n : undefined)
              }
            } else {
              onEdit(v === '' ? undefined : v)
            }
          }}
          style={{
            padding: '6px 8px', fontSize: '.85rem',
            border: `1px solid ${inputBorder}`, borderRadius: 4,
            background: 'var(--bg-1)', color: 'var(--text-0)',
          }}
        />
      )}

      {hint && (
        <div style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>{hint}</div>
      )}
      {rawText && (
        <div style={{
          fontSize: '.7rem', color: 'var(--text-3)', fontFamily: 'monospace',
          wordBreak: 'break-word',
        }}>
          PDF: {rawText}
        </div>
      )}
    </div>
  )
}


// ========== Identity mismatch banner ==========

function IdentityMismatchBanner({
  flags,
  onUseTyped,
}: {
  flags: ParserFlag[]
  onUseTyped: (field: string, typedValue: string) => void
}) {
  const idFlags = flags.filter(f => f.category === 'identity_mismatch' && f.severity === 'block')
  if (idFlags.length === 0) return null

  const meta = PARSER_FLAG_CATEGORY_META.identity_mismatch

  return (
    <div style={{
      padding: 14, marginBottom: 16, borderRadius: 8,
      border: `1px solid ${COLOR_DANGER}`, background: 'var(--bg-2)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <AlertCircle size={16} style={{ color: COLOR_DANGER }} />
        <div style={{ fontWeight: 600, fontSize: '.88rem', color: 'var(--text-0)' }}>
          {meta?.label || 'Identity mismatch'}
        </div>
      </div>
      <div style={{ fontSize: '.8rem', color: 'var(--text-2)', marginBottom: 12, lineHeight: 1.5 }}>
        {meta?.description} You must pick the correct value before building the lease.
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {idFlags.map((f, i) => (
          <div key={i} style={{
            display: 'grid', gridTemplateColumns: 'auto 1fr 1fr auto', gap: 10,
            alignItems: 'center', padding: 8, background: 'var(--bg-1)', borderRadius: 4,
          }}>
            <code style={{
              fontSize: '.72rem', color: 'var(--text-2)',
              background: 'var(--bg-2)', padding: '2px 5px', borderRadius: 3,
            }}>
              {f.field}
            </code>
            <div>
              <div style={{ fontSize: '.66rem', color: 'var(--text-3)' }}>You typed</div>
              <div style={{ fontSize: '.82rem', color: 'var(--text-0)', fontFamily: 'monospace', wordBreak: 'break-word' }}>
                {f.expected || '—'}
              </div>
            </div>
            <div>
              <div style={{ fontSize: '.66rem', color: 'var(--text-3)' }}>PDF says</div>
              <div style={{ fontSize: '.82rem', color: 'var(--text-0)', fontFamily: 'monospace', wordBreak: 'break-word' }}>
                {f.found || '—'}
              </div>
            </div>
            {f.expected && f.field && (
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => onUseTyped(f.field!, f.expected!)}
                title="Override the parsed value with what you originally typed"
                style={{ fontSize: '.72rem' }}
              >
                Use typed
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}


// ========== Read-only entity summary ==========


function SectionHeader({ title }: { title: string }) {
  return (
    <div style={{
      fontSize: '.76rem', fontWeight: 600, color: 'var(--text-2)',
      textTransform: 'uppercase', letterSpacing: '.04em',
      marginTop: 20, marginBottom: 10,
      paddingBottom: 6, borderBottom: '1px solid var(--border-0)',
    }}>
      {title}
    </div>
  )
}


// ========== Main modal ==========

export function ConfirmIntentModal({
  intentId,
  onClose,
  onResolved,
}: {
  intentId: string
  onClose: () => void
  onResolved: (result: ResolveResponseData) => void
}) {
  const [detail, setDetail] = useState<IntentDetail | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [overrides, setOverrides] = useState<OverridesMap>({})
  // S29c-2-F: editable entity arrays. Working state is separate from the
  // dot-path overrides map because mergeParserOutput wholesale-replaces these
  // arrays -- partial overrides would clobber parser data and crash the writer.
  const [entityArrays, setEntityArrays] = useState<Record<EntityArraySectionId, any[]>>({
    vehicles: [], rvs: [], pets: [], occupants: [],
    identifications: [], emergencyContacts: [],
  })
  const [entityObjects, setEntityObjects] = useState<Record<EntityObjectSectionId, any | null>>({
    liabilityInsurance: null, mobileHome: null,
  })
  const [touched, setTouched] = useState<Set<EntitySectionId>>(new Set())
  const [collapsed, setCollapsed] = useState<Set<EntitySectionId>>(new Set())
  const [pendingRemoval, setPendingRemoval] = useState<{ sectionId: EntityArraySectionId; idx: number; row: any } | null>(null)
  const removalTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const entitiesInitialized = useRef(false)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const data = await apiGet<IntentDetail>(`/landlords/me/pending-tenants/${intentId}`)
        if (!cancelled) setDetail(data)
      } catch (e: any) {
        if (!cancelled) setLoadError(e?.response?.data?.message || 'Failed to load intent')
      }
    }
    load()
    return () => { cancelled = true }
  }, [intentId])

  // S29c-2-F: seed entity working state once parser_output arrives.
  // initialCollapsed: empty sections collapse, populated sections expand.
  useEffect(() => {
    if (!detail?.parserOutput || entitiesInitialized.current) return
    const po = detail.parserOutput
    const next: Record<EntityArraySectionId, any[]> = {
      vehicles:          po.vehicles ? [...po.vehicles] : [],
      rvs:               po.rvs ? [...po.rvs] : [],
      pets:              po.pets ? [...po.pets] : [],
      occupants:         po.additionalOccupants ? [...po.additionalOccupants] : [],
      identifications:   po.tenants?.[0]?.identifications ? [...po.tenants[0].identifications] : [],
      emergencyContacts: po.tenants?.[0]?.emergencyContacts ? [...po.tenants[0].emergencyContacts] : [],
    }
    setEntityArrays(next)
    setEntityObjects({
      liabilityInsurance: po.liabilityInsurance ?? null,
      mobileHome:         po.mobileHome ?? null,
    })
    const initial = new Set<EntitySectionId>()
    ;(Object.keys(next) as EntityArraySectionId[]).forEach(k => {
      if (next[k].length === 0) initial.add(k)
    })
    if (!po.liabilityInsurance) initial.add('liabilityInsurance')
    if (!po.mobileHome)         initial.add('mobileHome')
    setCollapsed(initial)
    entitiesInitialized.current = true
  }, [detail])

  // Cleanup undo timer on unmount.
  useEffect(() => () => {
    if (removalTimerRef.current) clearTimeout(removalTimerRef.current)
  }, [])

  const markTouched = (sectionId: EntitySectionId) => {
    setTouched(prev => {
      if (prev.has(sectionId)) return prev
      const next = new Set(prev)
      next.add(sectionId)
      return next
    })
  }

  const updateEntityRow = (sectionId: EntityArraySectionId, idx: number, key: string, value: any) => {
    setEntityArrays(prev => {
      const arr = [...prev[sectionId]]
      const row = { ...arr[idx] }
      if (value === undefined || value === null || value === '') {
        delete row[key]
      } else {
        row[key] = asOverrideField(value)
      }
      arr[idx] = row
      return { ...prev, [sectionId]: arr }
    })
    markTouched(sectionId)
  }

  const addEntityRow = (sectionId: EntityArraySectionId) => {
    setEntityArrays(prev => ({
      ...prev,
      [sectionId]: [...prev[sectionId], freshRow(sectionId)],
    }))
    markTouched(sectionId)
    setCollapsed(prev => {
      if (!prev.has(sectionId)) return prev
      const next = new Set(prev)
      next.delete(sectionId)
      return next
    })
  }

  const removeEntityRow = (sectionId: EntityArraySectionId, idx: number) => {
    setEntityArrays(prev => {
      const arr = prev[sectionId]
      const removedRow = arr[idx]
      setPendingRemoval({ sectionId, idx, row: removedRow })
      if (removalTimerRef.current) clearTimeout(removalTimerRef.current)
      removalTimerRef.current = setTimeout(() => {
        setPendingRemoval(null)
        removalTimerRef.current = null
      }, 5000)
      return { ...prev, [sectionId]: arr.filter((_, i) => i !== idx) }
    })
    markTouched(sectionId)
  }

  const undoEntityRemoval = () => {
    setPendingRemoval(prev => {
      if (!prev) return null
      if (removalTimerRef.current) {
        clearTimeout(removalTimerRef.current)
        removalTimerRef.current = null
      }
      setEntityArrays(arrays => {
        const arr = [...arrays[prev.sectionId]]
        arr.splice(prev.idx, 0, prev.row)
        return { ...arrays, [prev.sectionId]: arr }
      })
      return null
    })
  }

  const dismissRemoval = () => {
    if (removalTimerRef.current) {
      clearTimeout(removalTimerRef.current)
      removalTimerRef.current = null
    }
    setPendingRemoval(null)
  }

  const updateEntityObject = (sectionId: EntityObjectSectionId, key: string, value: any) => {
    setEntityObjects(prev => {
      const cur = prev[sectionId] ?? {}
      const next = { ...cur }
      if (value === undefined || value === null || value === '') {
        delete next[key]
      } else {
        next[key] = asOverrideField(value)
      }
      return { ...prev, [sectionId]: next }
    })
    markTouched(sectionId)
  }

  const toggleCollapsed = (sectionId: EntitySectionId) => {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(sectionId)) next.delete(sectionId)
      else next.add(sectionId)
      return next
    })
  }

  const setOverride = (path: string, value: string | number | boolean | undefined) => {
    setOverrides(prev => {
      const next = { ...prev }
      if (value === undefined || value === '' || value === null) {
        delete next[path]
      } else {
        next[path] = value
      }
      return next
    })
  }

  const parsed = detail?.parserOutput
  const flags = detail?.parserFlags || []
  const hasBlockingFlags = flags.some(f => f.severity === 'block')

  const requiredPaths = [
    'tenants.0.firstName',
    'tenants.0.lastName',
    'tenants.0.email',
    'unit.propertyName',
    'unit.unitNumber',
    'lease.leaseStart',
    'lease.monthlyRent',
  ]
  const missingRequired = useMemo(() => {
    if (!parsed) return []
    const missing: string[] = requiredPaths.filter(p => {
      const overrideVal = overrides[p]
      if (overrideVal !== undefined && overrideVal !== '') return false
      const parsedField = fieldAt(parsed, p)
      const parsedValue = parsedField?.value
      return parsedValue === undefined || parsedValue === null || parsedValue === ''
    })
    // Entity-row required leaves mirror DB NOT NULL columns:
    // lease_vehicles.vehicle_type, lease_pets.species, lease_occupants.full_name,
    // tenant_identifications.id_type+id_number, emergency_contacts.name.
    const arraySections: EntityArraySectionId[] = ['vehicles', 'rvs', 'pets', 'occupants', 'identifications', 'emergencyContacts']
    for (const sectionId of arraySections) {
      const rows = entityArrays[sectionId]
      const reqFields = SECTION_META[sectionId].fields.filter(f => f.required)
      rows.forEach((row, idx) => {
        for (const fc of reqFields) {
          const v = row[fc.key]?.value
          if (v === undefined || v === null || v === '') {
            missing.push(`${sectionId}.${idx}.${fc.key}`)
          }
        }
      })
    }
    return missing
  }, [parsed, overrides, entityArrays])

  const canSubmit = !!parsed && !submitting && missingRequired.length === 0

  const handleSubmit = async () => {
    if (!canSubmit) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      const materialized: any = materializeOverrides(overrides)
      // S29c-2-F: layer in touched entity sections. mergeParserOutput's
      // `...overrides` spread treats these as wholesale replacements.
      // Untouched sections are omitted; parser_output flows through unchanged.
      if (touched.has('vehicles'))            materialized.vehicles            = entityArrays.vehicles
      if (touched.has('rvs'))                 materialized.rvs                 = entityArrays.rvs
      if (touched.has('pets'))                materialized.pets                = entityArrays.pets
      if (touched.has('occupants'))           materialized.additionalOccupants = entityArrays.occupants
      if (touched.has('liabilityInsurance'))  materialized.liabilityInsurance  = entityObjects.liabilityInsurance
      if (touched.has('mobileHome'))          materialized.mobileHome          = entityObjects.mobileHome
      // Tenant-nested arrays ride mergeTenants (which does { ...b, ...o } per index).
      if (touched.has('identifications') || touched.has('emergencyContacts')) {
        materialized.tenants = materialized.tenants || []
        materialized.tenants[0] = materialized.tenants[0] || {}
        if (touched.has('identifications'))   materialized.tenants[0].identifications   = entityArrays.identifications
        if (touched.has('emergencyContacts')) materialized.tenants[0].emergencyContacts = entityArrays.emergencyContacts
      }
      const body = { landlordOverrides: materialized }
      const res = await api.post<{ success: boolean; data: ResolveResponseData; message?: string }>(
        `/landlords/me/pending-tenants/${intentId}/resolve`,
        body,
      )
      onResolved(res.data.data)
    } catch (e: any) {
      setSubmitError(e?.response?.data?.message || e?.message || 'Build lease failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal"
        onClick={e => e.stopPropagation()}
        style={{
          maxWidth: 1200, width: '95vw', maxHeight: '92vh', height: '92vh',
          display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden',
        }}
      >
        <div style={{
          padding: '12px 16px', borderBottom: '1px solid var(--border-0)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: '1rem', color: 'var(--text-0)' }}>
              Confirm and build lease
            </div>
            {detail && (
              <div style={{ fontSize: '.78rem', color: 'var(--text-3)', marginTop: 2 }}>
                {detail.firstName} {detail.lastName} · {detail.email}
              </div>
            )}
          </div>
          <button onClick={onClose} className="btn btn-ghost btn-sm" aria-label="Close">
            <X size={16} />
          </button>
        </div>

        {!detail && !loadError ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-3)' }}>
            <Loader size={20} style={{ animation: 'spin 1s linear infinite', marginRight: 8 }} />
            Loading parsed lease…
          </div>
        ) : loadError ? (
          <div style={{ flex: 1, padding: 24, textAlign: 'center', color: 'var(--text-2)' }}>
            <AlertCircle size={24} style={{ color: COLOR_DANGER }} />
            <div style={{ marginTop: 8 }}>{loadError}</div>
          </div>
        ) : !parsed ? (
          <div style={{ flex: 1, padding: 24, textAlign: 'center', color: 'var(--text-2)' }}>
            <AlertTriangle size={24} style={{ color: COLOR_WARNING }} />
            <div style={{ marginTop: 8 }}>
              No parser output yet. Wait for parsing to complete or re-upload the document.
            </div>
          </div>
        ) : (
          <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '1fr 1fr', overflow: 'hidden' }}>
            <PdfPanel intentId={intentId} />

            <div style={{ overflow: 'auto', padding: 16, background: 'var(--bg-1)' }}>
              <IdentityMismatchBanner
                flags={flags}
                onUseTyped={(field, typedValue) => setOverride(field, typedValue)}
              />

              <SectionHeader title="Tenant identity" />
              <FieldRow label="First name"      parsed={fieldAt(parsed, 'tenants.0.firstName')}      override={overrides['tenants.0.firstName']}      onEdit={v => setOverride('tenants.0.firstName', v)} />
              <FieldRow label="Last name"       parsed={fieldAt(parsed, 'tenants.0.lastName')}       override={overrides['tenants.0.lastName']}       onEdit={v => setOverride('tenants.0.lastName', v)} />
              <FieldRow label="Email" type="email" parsed={fieldAt(parsed, 'tenants.0.email')}        override={overrides['tenants.0.email']}          onEdit={v => setOverride('tenants.0.email', v)} />
              <FieldRow label="Phone" type="tel"   parsed={fieldAt(parsed, 'tenants.0.phone')}        override={overrides['tenants.0.phone']}          onEdit={v => setOverride('tenants.0.phone', v)} />
              <FieldRow label="Date of birth" type="date" parsed={fieldAt(parsed, 'tenants.0.dateOfBirth')} override={overrides['tenants.0.dateOfBirth']}     onEdit={v => setOverride('tenants.0.dateOfBirth', v)} />
              <FieldRow label="Mailing address" parsed={fieldAt(parsed, 'tenants.0.mailingAddress')} override={overrides['tenants.0.mailingAddress']} onEdit={v => setOverride('tenants.0.mailingAddress', v)} />

              <EntityArraySection
                sectionId="identifications"
                rows={entityArrays.identifications}
                collapsed={collapsed.has('identifications')}
                touched={touched.has('identifications')}
                onToggleCollapsed={() => toggleCollapsed('identifications')}
                onUpdateRow={(idx, key, v) => updateEntityRow('identifications', idx, key, v)}
                onAddRow={() => addEntityRow('identifications')}
                onRemoveRow={idx => removeEntityRow('identifications', idx)}
              />

              <EntityArraySection
                sectionId="emergencyContacts"
                rows={entityArrays.emergencyContacts}
                collapsed={collapsed.has('emergencyContacts')}
                touched={touched.has('emergencyContacts')}
                onToggleCollapsed={() => toggleCollapsed('emergencyContacts')}
                onUpdateRow={(idx, key, v) => updateEntityRow('emergencyContacts', idx, key, v)}
                onAddRow={() => addEntityRow('emergencyContacts')}
                onRemoveRow={idx => removeEntityRow('emergencyContacts', idx)}
              />

              <SectionHeader title="Property and unit" />
              <FieldRow label="Property name"    parsed={fieldAt(parsed, 'unit.propertyName')}    override={overrides['unit.propertyName']}    onEdit={v => setOverride('unit.propertyName', v)} />
              <FieldRow label="Unit number"      parsed={fieldAt(parsed, 'unit.unitNumber')}      override={overrides['unit.unitNumber']}      onEdit={v => setOverride('unit.unitNumber', v)} />
              <FieldRow label="Property address" parsed={fieldAt(parsed, 'unit.propertyAddress')} override={overrides['unit.propertyAddress']} onEdit={v => setOverride('unit.propertyAddress', v)} />
              <FieldRow label="Unit type" type="select" options={UNIT_TYPES.map(t => ({ value: t, label: t.replace(/_/g, ' ') }))} parsed={fieldAt(parsed, 'unit.unitType')} override={overrides['unit.unitType']} onEdit={v => setOverride('unit.unitType', v)} />

              <SectionHeader title="Lease terms" />
              <FieldRow label="Lease type" type="select" options={LEASE_TYPES.map(t => ({ value: t, label: t.replace(/_/g, ' ') }))} parsed={fieldAt(parsed, 'lease.leaseType')} override={overrides['lease.leaseType']} onEdit={v => setOverride('lease.leaseType', v)} />
              <FieldRow label="Start date" type="date" parsed={fieldAt(parsed, 'lease.leaseStart')} override={overrides['lease.leaseStart']} onEdit={v => setOverride('lease.leaseStart', v)} />
              <FieldRow label="End date"   type="date" parsed={fieldAt(parsed, 'lease.leaseEnd')}   override={overrides['lease.leaseEnd']}   onEdit={v => setOverride('lease.leaseEnd', v)} hint="Leave blank for month-to-month" />
              <FieldRow label="Monthly rent"        type="number" parsed={fieldAt(parsed, 'lease.monthlyRent')}        override={overrides['lease.monthlyRent']}        onEdit={v => setOverride('lease.monthlyRent', v)} />
              <FieldRow label="Security deposit"    type="number" parsed={fieldAt(parsed, 'lease.securityDeposit')}    override={overrides['lease.securityDeposit']}    onEdit={v => setOverride('lease.securityDeposit', v)} />
              <FieldRow label="Late fee amount"     type="number" parsed={fieldAt(parsed, 'lease.lateFeeAmount')}     override={overrides['lease.lateFeeAmount']}     onEdit={v => setOverride('lease.lateFeeAmount', v)} />
              <FieldRow label="Late fee grace days" type="number" parsed={fieldAt(parsed, 'lease.lateFeeGraceDays')} override={overrides['lease.lateFeeGraceDays']} onEdit={v => setOverride('lease.lateFeeGraceDays', v)} />
              <FieldRow label="Auto-renew"          type="checkbox" parsed={fieldAt(parsed, 'lease.autoRenew')}      override={overrides['lease.autoRenew']}      onEdit={v => setOverride('lease.autoRenew', v)} />
              <FieldRow label="Auto-renew mode"     type="select"
                options={[
                  ...AUTO_RENEW_MODES.map(m => ({ value: m, label: m.replace(/_/g, ' ') })),
                ]}
                parsed={fieldAt(parsed, 'lease.autoRenewMode')} override={overrides['lease.autoRenewMode']} onEdit={v => setOverride('lease.autoRenewMode', v)} />
              <FieldRow label="Notice days required" type="number" parsed={fieldAt(parsed, 'lease.noticeDaysRequired')} override={overrides['lease.noticeDaysRequired']} onEdit={v => setOverride('lease.noticeDaysRequired', v)} />
              <FieldRow label="Subleasing policy" type="select"
                options={SUBLEASING_POLICIES.map((s: string) => ({ value: s, label: s.replace(/_/g, ' ') }))}
                parsed={fieldAt(parsed, 'lease.subleasingAllowed')} override={overrides['lease.subleasingAllowed']} onEdit={v => setOverride('lease.subleasingAllowed', v)} />

              <SectionHeader title="Co-residents" />
              <EntityArraySection
                sectionId="occupants"
                rows={entityArrays.occupants}
                collapsed={collapsed.has('occupants')}
                touched={touched.has('occupants')}
                onToggleCollapsed={() => toggleCollapsed('occupants')}
                onUpdateRow={(idx, key, v) => updateEntityRow('occupants', idx, key, v)}
                onAddRow={() => addEntityRow('occupants')}
                onRemoveRow={idx => removeEntityRow('occupants', idx)}
              />
              <EntityArraySection
                sectionId="pets"
                rows={entityArrays.pets}
                collapsed={collapsed.has('pets')}
                touched={touched.has('pets')}
                onToggleCollapsed={() => toggleCollapsed('pets')}
                onUpdateRow={(idx, key, v) => updateEntityRow('pets', idx, key, v)}
                onAddRow={() => addEntityRow('pets')}
                onRemoveRow={idx => removeEntityRow('pets', idx)}
              />

              <SectionHeader title="Vehicles and RVs" />
              <EntityArraySection
                sectionId="vehicles"
                rows={entityArrays.vehicles}
                collapsed={collapsed.has('vehicles')}
                touched={touched.has('vehicles')}
                onToggleCollapsed={() => toggleCollapsed('vehicles')}
                onUpdateRow={(idx, key, v) => updateEntityRow('vehicles', idx, key, v)}
                onAddRow={() => addEntityRow('vehicles')}
                onRemoveRow={idx => removeEntityRow('vehicles', idx)}
              />
              <EntityArraySection
                sectionId="rvs"
                rows={entityArrays.rvs}
                collapsed={collapsed.has('rvs')}
                touched={touched.has('rvs')}
                onToggleCollapsed={() => toggleCollapsed('rvs')}
                onUpdateRow={(idx, key, v) => updateEntityRow('rvs', idx, key, v)}
                onAddRow={() => addEntityRow('rvs')}
                onRemoveRow={idx => removeEntityRow('rvs', idx)}
              />

              <SectionHeader title="Insurance and dwelling" />
              <EntityObjectSection
                sectionId="liabilityInsurance"
                obj={entityObjects.liabilityInsurance}
                collapsed={collapsed.has('liabilityInsurance')}
                touched={touched.has('liabilityInsurance')}
                onToggleCollapsed={() => toggleCollapsed('liabilityInsurance')}
                onUpdateField={(key, v) => updateEntityObject('liabilityInsurance', key, v)}
              />
              <EntityObjectSection
                sectionId="mobileHome"
                obj={entityObjects.mobileHome}
                collapsed={collapsed.has('mobileHome')}
                touched={touched.has('mobileHome')}
                onToggleCollapsed={() => toggleCollapsed('mobileHome')}
                onUpdateField={(key, v) => updateEntityObject('mobileHome', key, v)}
              />

              <div style={{ height: 24 }} />
            </div>
          </div>
        )}

        <div style={{
          padding: '12px 16px', borderTop: '1px solid var(--border-0)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
          background: 'var(--bg-2)',
        }}>
          <div style={{ fontSize: '.76rem', color: 'var(--text-3)', flex: 1 }}>
            {missingRequired.length > 0 && parsed ? (
              <span style={{ color: COLOR_DANGER }}>
                Missing required: {missingRequired.map(p => p.split('.').pop()).join(', ')}
              </span>
            ) : Object.keys(overrides).length > 0 ? (
              <span>{Object.keys(overrides).length} field{Object.keys(overrides).length === 1 ? '' : 's'} edited</span>
            ) : hasBlockingFlags ? (
              <span style={{ color: COLOR_DANGER }}>Resolve blockers above before building</span>
            ) : (
              <span>Review parsed values, then build the lease</span>
            )}
          </div>
          {submitError && (
            <div style={{
              padding: '4px 10px', borderRadius: 4,
              background: 'var(--bg-1)', borderLeft: `3px solid ${COLOR_DANGER}`,
              fontSize: '.78rem', color: 'var(--text-1)',
            }}>
              {submitError}
            </div>
          )}
          <button onClick={onClose} className="btn btn-ghost" disabled={submitting}>
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="btn btn-primary"
            style={{ minWidth: 130, opacity: canSubmit ? 1 : 0.5 }}
          >
            {submitting ? (
              <>
                <Loader size={14} style={{ animation: 'spin 1s linear infinite', marginRight: 6 }} />
                Building…
              </>
            ) : (
              <>
                <CheckCircle2 size={14} style={{ marginRight: 6 }} />
                Build lease
              </>
            )}
          </button>
        </div>
        {pendingRemoval && (
          <UndoToast
            message={`${SECTION_META[pendingRemoval.sectionId].rowLabel.charAt(0).toUpperCase()}${SECTION_META[pendingRemoval.sectionId].rowLabel.slice(1)} removed`}
            onUndo={undoEntityRemoval}
            onDismiss={dismissRemoval}
          />
        )}
      </div>
    </div>
  )
}
