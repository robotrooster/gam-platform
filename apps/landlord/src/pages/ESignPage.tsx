// @ts-nocheck
import { useState, useRef, useCallback, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { apiGet, apiPost, apiPatch, apiDelete, apiPut } from '../lib/api'
import { loadPdfjs } from '../lib/pdfjs'
import { LEASE_COLUMNS, LEASE_COLUMN_LABEL, LEASE_COLUMN_INPUT, humanize, isLockedLeaseColumn,
  STANDALONE_DOCUMENT_TYPES, LEASE_DOCUMENT_TYPE_LABEL, GENERIC_SIGNER_ROLES, GENERIC_SIGNER_ROLE_LABEL,
  AUTO_PLACE_ESTIMATE, autoPlaceTimeoutMs, LEASE_COLUMN_CATEGORY, FEE_TYPE_META,
  SCREENING_FEE_EXCLUSION_REASON,
  isAutoFilledLeaseColumn,
} from '@gam/shared'
import { useAuth } from '../context/AuthContext'
import { usePerms } from '../lib/permissions'
import { SearchBox, PropertySelect } from '../components/ListControls'
import { Plus, X, FileText, Send, Settings, Eye, Trash2, ChevronRight, Check, AlertCircle, Download, MoreVertical, Undo2, Redo2, PenLine } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { toast, appConfirm } from '../components/dialogs'

const API_URL = (import.meta as any).env?.VITE_API_URL || 'http://localhost:4000'

const FIELD_TYPES = [
  { type:'signature', label:'Signature',  icon:'✍️', color:'#c9a227', w:200, h:60 },
  { type:'initials',  label:'Initials',   icon:'🔡', color:'#4a9eff', w:80,  h:50 },
  { type:'date',      label:'Date',       icon:'📅', color:'#22c55e', w:140, h:40 },
  { type:'text',      label:'Text Field', icon:'📝', color:'#a78bfa', w:200, h:40 },
  { type:'checkbox',  label:'Checkbox',   icon:'☑️', color:'#f59e0b', w:30,  h:30 },
  { type:'radio_group',label:'Multiple Choice', icon:'🔘', color:'#ec4899', w:16, h:16 },
]

// Lease roles + S568 generic roles (standalone contracts: purchase agreements,
// bills of sale, general contracts — the field editor can place boxes for these).
const SIGNER_ROLES = ['landlord','primary','co_tenant_1','co_tenant_2','co_tenant_3','witness',
  'seller','purchaser','party_1','party_2']

// DATA_LABELS derived from the shared lease_column registry. Single source
// of truth is @gam/shared — adding a value there automatically surfaces it
// (or not, if LEASE_COLUMN_INPUT is 'implicit'). No local drift possible.
// Signature/initial bindings are 'implicit' (field type + signer role).
// S582: rent_due_day is PLATFORM-LOCKED to the 1st (see @gam/shared
// WRITABLE_LEASE_COLUMN_SPECS) — never offer it as a placeable field, so no
// signed lease can state a due day the billing engine won't honor.
const PALETTE_EXCLUDED = new Set(['rent_due_day'])
const DATA_LABELS: Record<string, Array<{value:string; label:string}>> = {
  text: LEASE_COLUMNS
    .filter(c => LEASE_COLUMN_INPUT[c] === 'text' && !PALETTE_EXCLUDED.has(c))
    .map(c => ({ value: c, label: LEASE_COLUMN_LABEL[c] })),
  date: LEASE_COLUMNS
    .filter(c => LEASE_COLUMN_INPUT[c] === 'date' && !PALETTE_EXCLUDED.has(c))
    .map(c => ({ value: c, label: LEASE_COLUMN_LABEL[c] })),
}
// S622 (Nic): the Data label dropdown is how a landlord RE-TAGS a box the
// auto-placer got wrong — "can a landlord mark a box as a lease fee item".
// They always could. What the form never said is that this tag is what makes
// GAM BILL the tenant, so there was no way to know that picking "Pet fee"
// creates a charge, or that leaving it blank means the amount prints and
// bills nobody. Spell out the consequence under the control.
function billingEffect(col: string | null | undefined): { text: string; billing: boolean } {
  if (!col) return { text: 'Prints on the lease only — nothing is billed for this box.', billing: false }
  const cat = (LEASE_COLUMN_CATEGORY as Record<string, string>)[col]
  if (cat === 'fee_row') {
    const meta = (FEE_TYPE_META as Record<string, any>)[col]
    const refund = meta?.isRefundable ? ' Refundable — returned at move-out.' : ''
    if (meta?.dueTiming === 'move_in') return { text: `Billed on the tenant's FIRST invoice, at move-in.${refund}`, billing: true }
    if (meta?.dueTiming === 'monthly_ongoing') return { text: 'Billed EVERY MONTH alongside rent.', billing: true }
    if (meta?.dueTiming === 'move_out') return { text: 'Charged at move-out, from the deposit.', billing: true }
    return { text: 'Recorded on the lease; billed when you choose to bill it.', billing: true }
  }
  if (cat === 'writable') return { text: 'Sets this value on the lease itself.', billing: true }
  if (cat === 'utility_row') return { text: 'Sets who pays this utility.', billing: false }
  return { text: 'Recorded on the lease.', billing: false }
}

const ROLE_COLORS: Record<string,string> = {
  landlord:'#c9a227', primary:'#22c55e', co_tenant_1:'#4a9eff', co_tenant_2:'#a78bfa', co_tenant_3:'#f472b6', witness:'#f59e0b',
  seller:'#c9a227', purchaser:'#22c55e', party_1:'#4a9eff', party_2:'#a78bfa'
}

// ── FIELD ITEM ON CANVAS ──────────────────────────────────────
// S622 (Nic): "how would a user manually doing it make it nested... how do you
// know what subordinates inside of another one without any sort of visual
// indicator?" Nesting was invisible on the canvas — you had to select a field
// and read a dropdown. A ring per depth makes the structure legible at a glance:
// no ring is top level, blue sits inside one option, purple inside that.
const DEPTH_RING = ['', '#4a9eff', '#a78bfa', '#f472b6']

function FieldItem({ field, selected, onSelect, onMove, onDelete, onResize, scale, parentLabel, depth = 0 }: any) {
  const ft = FIELD_TYPES.find(f => f.type === field.fieldType) || FIELD_TYPES[0]
  const color = ROLE_COLORS[field.signerRole] || '#888'
  const dragRef = useRef<{startX:number;startY:number;fieldX:number;fieldY:number}|null>(null)
  // S558 (Nic): late-fee boxes are policy-controlled — locked from move / resize
  // / delete / edit so the landlord can't tamper with the stamped fee (anti-
  // discrimination; the signed lease is the legal charge). S582: same lock covers
  // rent_due_day (platform-locked to the 1st).
  const locked = isLockedLeaseColumn(field.leaseColumn)

  const onResizeMouseDown = (e: React.MouseEvent, handle: string) => {
    e.stopPropagation(); e.preventDefault()
    const startX = e.clientX, startY = e.clientY
    const startW = field.width, startH = field.height
    const onMouseMove = (ev: MouseEvent) => {
      const dx = (ev.clientX - startX) / scale
      const dy = (ev.clientY - startY) / scale
      let newW = startW, newH = startH
      if (handle.includes('e')) newW = Math.max(30, startW + dx)
      if (handle.includes('s')) newH = Math.max(15, startH + dy)
      if (handle.includes('w')) newW = Math.max(30, startW - dx)
      if (handle.includes('n')) newH = Math.max(15, startH - dy)
      onResize(field.id, newW, newH)
    }
    const onMouseUp = () => { window.removeEventListener('mousemove', onMouseMove); window.removeEventListener('mouseup', onMouseUp) }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }

  const onMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    onSelect(field.id)
    if (locked) return // locked late-fee box: select only, no drag
    const startX = e.clientX
    const startY = e.clientY
    let moved = false
    dragRef.current = { startX, startY, fieldX: field.x, fieldY: field.y }
    const onMouseMove = (ev: MouseEvent) => {
      if (!dragRef.current) return
      const dx = ev.clientX - startX
      const dy = ev.clientY - startY
      if (!moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return
      moved = true
      onMove(field.id, Math.max(0, dragRef.current.fieldX + dx/scale), Math.max(0, dragRef.current.fieldY + dy/scale))
    }
    const onMouseUp = () => {
      dragRef.current = null
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }

  const isConditional = !!field.parentFieldId

  return (
    <div style={{ position:'absolute', left: field.x * scale - 1, top: field.y * scale - 1 }} onMouseDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}>
      {/* Delete button — outside the draggable area. Hidden for locked late-fee boxes. */}
      {selected && !locked && (
        <div
          onMouseDown={e => { e.stopPropagation(); e.preventDefault() }}
          onClick={e => { e.stopPropagation(); onDelete(field.id) }}
          style={{ position:'absolute', top:-14, right:-14, width:22, height:22, borderRadius:'50%', background:'#ef4444', border:'2px solid white', cursor:'pointer', color:'white', display:'flex', alignItems:'center', justifyContent:'center', fontSize:12, fontWeight:900, zIndex:999, lineHeight:1, userSelect:'none', pointerEvents:'all' }}>
          ×
        </div>
      )}
      {/* Field box. Late-fee boxes render locked (no drag cursor, lock badge). */}
      {/* S622: a CONDITIONAL child looked identical to a top-level field on the
          canvas — its parent link only showed in the properties panel, and only
          while selected. Nic read a correctly-nested sub-radio ("at end of term"
          under lease type = Fixed term) as a stray second radio group, because
          nothing on the page said otherwise. Dashed border + a caption naming
          the condition. */}
      {/* S622: this caption is nowrap and can run far wider than its 14px box,
          so on a dense page it laid itself across the fields either side —
          Nic saw "wording highlighted, kinda hidden behind the end date box".
          Only the selected field explains itself now; the rest carry a small
          marker, with the full condition on hover. */}
      {isConditional && (selected ? (
        <div style={{
          position:'absolute', bottom:'100%', left:0, marginBottom:2,
          fontSize: Math.max(7, 8.5 * scale), color, fontWeight:700,
          whiteSpace:'nowrap' as const, pointerEvents:'none', opacity:.95,
          background:'var(--bg-0)', padding:'0 3px', borderRadius:3, zIndex:30,
        }}>
          ↳ only if {parentLabel ? `${parentLabel} = ` : ''}{field.parentOption || 'parent is set'}
        </div>
      ) : (
        <div style={{
          position:'absolute', bottom:'100%', left:0, marginBottom:1,
          fontSize: Math.max(6, 7 * scale), color, fontWeight:700,
          pointerEvents:'none', opacity:.75, lineHeight:1,
        }}>↳</div>
      ))}
      <div onMouseDown={onMouseDown} title={locked ? 'Late-fee field — set by the property Late Fees policy, locked' : isConditional ? `Shown only when ${parentLabel || 'the parent field'} = ${field.parentOption}` : undefined} style={{
        position:'relative', width: field.width * scale, height: field.height * scale,
        border: `2px ${isConditional ? 'dashed' : 'solid'} ${selected ? color : color + '99'}`,
        // Depth ring — drawn outside the box so it never eats the field's own
        // colour, which still says WHO fills it.
        boxShadow: depth > 0 ? `0 0 0 ${Math.max(1, Math.round(2 * scale))}px ${DEPTH_RING[Math.min(depth, 3)]}` : undefined,
        borderRadius: field.fieldType === 'checkbox' ? 4 : 6,
        background: `${color}18`,
        cursor: locked ? 'not-allowed' : 'move', userSelect:'none', boxSizing:'border-box' as const,
        display:'flex', alignItems:'center', justifyContent:'center', gap:4,
        overflow:'visible',
      }}>
        {locked && <span style={{ position:'absolute', top:-8, left:-8, fontSize: Math.max(9, 11*scale), zIndex:998, pointerEvents:'none' }}>🔒</span>}
        <span style={{ fontSize: Math.max(8, 11 * scale), flexShrink:0, pointerEvents:'none' }}>{ft.icon}</span>
        {field.width * scale > 50 && (
          <span style={{ color, fontWeight:700, whiteSpace:'nowrap' as const, overflow:'hidden', textOverflow:'ellipsis', fontSize: Math.max(7, 9 * scale), pointerEvents:'none' }}>
            {field.label || ft.label}
          </span>
        )}
        {selected && !locked && [
          { id:'e',  style:{ position:'absolute' as const, right:-5, top:'50%', transform:'translateY(-50%)', cursor:'ew-resize',   width:8, height:20, background:color, borderRadius:2, zIndex:20 } },
          { id:'s',  style:{ position:'absolute' as const, bottom:-5, left:'50%', transform:'translateX(-50%)', cursor:'ns-resize',  width:20, height:8, background:color, borderRadius:2, zIndex:20 } },
          { id:'se', style:{ position:'absolute' as const, right:-5, bottom:-5, cursor:'nwse-resize', width:10, height:10, background:color, borderRadius:2, zIndex:20 } },
          { id:'sw', style:{ position:'absolute' as const, left:-5,  bottom:-5, cursor:'nesw-resize', width:10, height:10, background:color, borderRadius:2, zIndex:20 } },
        ].map(h => <div key={h.id} onMouseDown={e => onResizeMouseDown(e, h.id)} style={h.style} />)}
      </div>
    </div>
  )
}

// ── PDF CANVAS RENDERER ──────────────────────────────────────
function PDFCanvas({ url, page, width, height }: { url:string; page:number; width:number; height:number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    let cancelled = false
    const render = async () => {
      try {
        const pdfjsLib = await loadPdfjs()
        // S535: template PDFs are served by the authed /api/esign/files
        // route — attach the Bearer token (pdf.js fetches the URL itself,
        // so the axios interceptor never sees this request).
        const loadingTask = pdfjsLib.getDocument({
          url, httpHeaders: { Authorization: 'Bearer ' + (localStorage.getItem('gam_token') || '') }
        })
        const pdf = await loadingTask.promise
        if (cancelled) return
        const pdfPage = await pdf.getPage(page)
        if (cancelled) return
        const canvas = canvasRef.current
        if (!canvas) return
        const ctx = canvas.getContext('2d')!
        const viewport = pdfPage.getViewport({ scale: width / pdfPage.getViewport({ scale:1 }).width })
        canvas.width  = viewport.width
        canvas.height = viewport.height
        await pdfPage.render({ canvasContext: ctx, viewport }).promise
      } catch(e) {
        console.error('[PDFCanvas]', e)
      }
    }
    render()
    return () => { cancelled = true }
  }, [url, page, width])

  return <canvas ref={canvasRef} style={{ position:'absolute', inset:0, width:'100%', height:'100%', pointerEvents:'none' }} />
}

// ── TEMPLATE EDITOR ───────────────────────────────────────────
function TemplateEditor({ template, onClose }: { template: any; onClose: () => void }) {
  console.log('[TEMPLATE EDITOR] template:', template)
  const qc = useQueryClient()
  // S622 (Nic): "if I accidentally move a box over a little bit, and I wanna undo
  // it to get the placement back right... like on a paintbrush program."
  //
  // Placement is direct manipulation — drag, resize, delete — and every one of
  // those is a small destructive edit with nothing behind it. Nudging a box off a
  // blank meant dragging it back by eye and never quite recovering the original.
  //
  // History wraps the field list itself rather than recording per-action deltas:
  // a drag emits many setFields calls, so an action-log would need every caller
  // to declare its boundaries. Snapshots are coarser and always correct.
  // Consecutive snapshots within 400ms collapse into one, so a drag lands as a
  // single undo step instead of forty.
  // ONE piece of state, because two cannot be kept in step. The first version
  // held the stack and the cursor separately and called setHistAt from INSIDE
  // the setHistory updater — React may run an updater twice, so the cursor could
  // advance past the end of the stack, `fields` became undefined, and the first
  // .filter on it took the whole editor down. Nic hit it by dragging a box:
  // "the thing crashed and I lost the rendering of the whole page."
  //
  // Snapshots rather than an action log: a drag emits many setFields calls, so
  // a log would need every caller to declare its own boundaries. Bursts within
  // 400ms collapse, so one drag is one undo step.
  const [hist, setHist] = useState<{ stack: any[][]; at: number }>(
    () => ({ stack: [template.fields || []], at: 0 }))
  const lastPush = useRef(0)
  // Never index past the end, whatever happens above.
  const fields = hist.stack[Math.min(hist.at, hist.stack.length - 1)] ?? []

  const setFields = useCallback((next: any) => {
    setHist(prev => {
      const at = Math.min(prev.at, prev.stack.length - 1)
      const cur = prev.stack[at] ?? []
      const value = typeof next === 'function' ? next(cur) : next
      const now = Date.now()
      if (now - lastPush.current < 400) {
        lastPush.current = now
        const stack = prev.stack.slice(0, at + 1)
        stack[stack.length - 1] = value
        return { stack, at: stack.length - 1 }
      }
      lastPush.current = now
      const stack = prev.stack.slice(0, at + 1)   // a new edit drops the redo tail
      stack.push(value)
      if (stack.length > 60) stack.shift()
      return { stack, at: stack.length - 1 }
    })
  }, [])

  const canUndo = hist.at > 0
  const canRedo = hist.at < hist.stack.length - 1
  const undo = useCallback(() => {
    lastPush.current = 0
    setHist(p => ({ ...p, at: Math.max(0, p.at - 1) }))
  }, [])
  const redo = useCallback(() => {
    lastPush.current = 0
    setHist(p => ({ ...p, at: Math.min(p.stack.length - 1, p.at + 1) }))
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (!mod || e.key.toLowerCase() !== 'z') return
      const t = e.target as HTMLElement | null
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return  // let the field own it
      e.preventDefault()
      if (e.shiftKey) redo(); else undo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo])
  const [selectedField, setSelectedField] = useState<string|null>(null)
  const [activeTool, setActiveTool] = useState<string|null>(null)
  const [activeRole, setActiveRole] = useState('primary')
  const [currentPage, setCurrentPage] = useState(1)
  // S622: real placement progress, reported per page by the job (the model
  // classifies one page at a time). null until the first poll carries a count.
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  // S622: fees the lease states in PROSE — no blank, so no box could ever carry
  // them ("$100 at move-out unless the carpets were professionally cleaned").
  // Detected from the template text, kept or dropped here, saved with the fields.
  const [conditionalFees, setConditionalFees] = useState<any[]>(template.conditionalFees || [])
  // S622: dollar figures hard-coded in the lease TEXT that nothing tracks. On a
  // blank form every amount in the prose is a stated amount, so each of these is
  // money the lease commits to that GAM would not otherwise know about. Advisory
  // only — not saved; it is a prompt to go tag something.
  const [unattributed, setUnattributed] = useState<any[]>([])
  // S622: background-check fees found in the lease and deliberately excluded.
  // Shown, not dropped — Nic: "we wanna identify them just to make sure that
  // we're purposely ignoring them, not accidentally ignoring them."
  const [screeningFees, setScreeningFees] = useState<any[]>([])
  // S622: the late-fee terms the lease states in words, read from the prose.
  const [lateFeeTerms, setLateFeeTerms] = useState<any>(template.lateFeeTerms ?? null)
  // S622: what the placer recognised, and what read like a choice it could not
  // lay out. Advisory — not saved.
  const [detection, setDetection] = useState<any>(null)
  const [scale, setScale] = useState(0.9)
  const canvasRef = useRef<HTMLDivElement>(null)
  const lastSizes = useRef<Record<string,{w:number,h:number}>>({})
  const pdfW = 612  // Letter width in points
  const pdfH = 792  // Letter height in points

  const getSelected = () => fields.find(f => f.id === selectedField)

  const handleCanvasClick = (e: React.MouseEvent) => {
    // Don't deselect if we clicked on a field (they stopPropagation)
    if (!activeTool) { setSelectedField(null); return }
    const rect = canvasRef.current!.getBoundingClientRect()
    const x = (e.clientX - rect.left) / scale
    const y = (e.clientY - rect.top) / scale
    const ft = FIELD_TYPES.find(f => f.type === activeTool)!
    const remembered = lastSizes.current[activeTool]
    const newField = {
      id: `f_${Date.now()}`, fieldType: activeTool, signerRole: activeRole,
      label: ft.label, page: currentPage, x, y,
      width: remembered ? remembered.w : ft.w,
      height: remembered ? remembered.h : ft.h, required: true
    }
    setFields(prev => [...prev, newField])
    setSelectedField(newField.id)
  }

  const moveField = useCallback((id: string, x: number, y: number) => {
    setFields(prev => prev.map(f => f.id === id ? {...f, x: Math.max(0, Math.min(x, pdfW-f.width)), y: Math.max(0, Math.min(y, pdfH-f.height))} : f))
  }, [])

  const resizeField = useCallback((id: string, width: number, height: number) => {
    setFields(prev => {
      const updated = prev.map(f => {
        if (f.id === id) {
          const newW = Math.max(20, width)
          const newH = Math.max(15, height)
          lastSizes.current[f.fieldType] = { w: newW, h: newH }
          return { ...f, width: newW, height: newH }
        }
        return f
      })
      return updated
    })
  }, [])

  const updateSelected = (key: string, value: any) => {
    setFields(prev => prev.map(f => f.id === selectedField ? {...f, [key]: value} : f))
  }

  const saveMut = useMutation(
    () => apiPut(`/esign/templates/${template.id}/fields`, { fields: fields.map(f => ({
      fieldType: f.fieldType, signerRole: f.signerRole, label: f.label,
      page: f.page, x: f.x, y: f.y, width: f.width, height: f.height, required: f.required,
      leaseColumn: f.leaseColumn || null, options: f.options || null,
      // S556: conditional nesting — clientId is this field's stable key, and
      // parentClientId points at the parent field's clientId (the server maps
      // both to new DB ids after the full-replace insert).
      clientId: f.id, parentClientId: f.parentFieldId || null, parentOption: f.parentOption || null
    })), lateFeeTerms, conditionalFees: conditionalFees.map((c: any) => ({
      label: c.label, amount: c.amount, conditionText: c.conditionText,
    })) }),
    { onSuccess: () => { qc.invalidateQueries('esign-templates'); onClose() } }
  )

  // S556 + S582: auto-place fields from the raw lease PDF (detection + in-house
  // model tagging). ASYNC — POST starts a job on the model box, then we poll for
  // the result on a separate call, so no request is held open long enough for
  // Cloudflare's ~100s edge timeout to bite. Loads proposals into the editor for
  // review/adjust; nothing is saved until "Save Fields". Re-running replaces the set.
  const autoMut = useMutation(
    async () => {
      const start: any = await apiPost(`/esign/templates/${template.id}/auto-fields`, {})
      const jobId = start?.data?.jobId
      if (!jobId) throw new Error('Could not start auto-placement')
      // S622: the cap scales with the document (see autoPlaceTimeoutMs). A flat
      // cap is what discarded a finished 8-page placement.
      const deadline = Date.now() + autoPlaceTimeoutMs(template.pageCount)
      for (;;) {
        await new Promise(r => setTimeout(r, 2500))
        // apiGet UNWRAPS the envelope (returns r.data.data); apiPost does NOT
        // (returns r.data). Reading this poll the apiPost way — s.data.status —
        // made `st` undefined on every pass, so a job that finished in 100s span
        // the spinner until the 4-minute client cap and threw the placed fields
        // away. Read the payload directly.
        const s: any = await apiGet(`/esign/templates/${template.id}/auto-fields/${jobId}`)
        const st = s?.status
        if (st === 'done') return s.result
        if (st === 'error') throw new Error(s?.error || 'Auto-placement failed')
        if (typeof s?.pagesTotal === 'number') setProgress({ done: s.pagesDone || 0, total: s.pagesTotal })
        if (Date.now() > deadline) throw new Error('Auto-placement is taking too long — please try again')
      }
    },
    {
      onSuccess: (result: any) => {
        const raw = result?.fields || []
        // First pass: assign editor ids + remember each proposal's radio key.
        const keyToId: Record<string,string> = {}
        const proposed = raw.map((f: any, i: number) => {
          const id = `a_${Date.now()}_${i}`
          if (f.key) keyToId[f.key] = id
          return {
            id, _parentKey: f.parentKey || null,
            fieldType: f.fieldType, signerRole: f.signerRole,
            label: f.label || (FIELD_TYPES.find(t => t.type === f.fieldType)?.label ?? 'Field'),
            page: f.page || 1, x: f.x, y: f.y, width: f.width, height: f.height,
            required: true, leaseColumn: f.leaseColumn || null, options: f.options || null,
            parentOption: f.parentOption || null, parentFieldId: null,
          }
        })
        // Second pass: resolve conditional parent links (radio key → editor id).
        for (const p of proposed) {
          if (p._parentKey && keyToId[p._parentKey]) p.parentFieldId = keyToId[p._parentKey]
          delete p._parentKey
        }
        setFields(proposed)
        setSelectedField(null)
        // Merge what the prose scan found, keyed on the clause itself so
        // re-running auto-place never duplicates one the landlord already kept.
        setUnattributed(Array.isArray(result?.unattributedAmounts) ? result.unattributedAmounts : [])
        setScreeningFees(Array.isArray(result?.screeningFees) ? result.screeningFees : [])
        if (result?.lateFeeTerms) setLateFeeTerms(result.lateFeeTerms)
        setDetection(result?.detection ?? null)
        if (Array.isArray(result?.conditionalFees) && result.conditionalFees.length > 0) {
          setConditionalFees(prev => {
            const seen = new Set(prev.map((c: any) => String(c.conditionText).trim()))
            const fresh = result.conditionalFees.filter((c: any) => !seen.has(String(c.conditionText).trim()))
            return [...prev, ...fresh]
          })
        }
        // S582: when the AI labeling couldn't run (model offline), boxes are still
        // placed by pattern detection — tell the landlord to double-check labels
        // rather than trust silent guesses.
        if (result?.modelUsed === false) {
          toast(`Placed ${proposed.length} field${proposed.length === 1 ? '' : 's'} by pattern detection (smart labeling was unavailable) — double-check each label before saving`)
        } else {
          toast(`Placed ${proposed.length} field${proposed.length === 1 ? '' : 's'} — review and adjust, then Save`)
        }
      },
      onError: (e: any) => toast.error(e?.message || 'Auto-placement failed'),
      onSettled: () => setProgress(null),
    }
  )

  const handleAutoPlace = async () => {
    if (fields.length > 0 && !(await appConfirm('Replace the current fields with auto-placed ones? Your current fields will be cleared.'))) return
    setProgress(null)
    autoMut.mutate()
  }

  // S622: what the landlord reads while the model works. Before the first page
  // lands we only know the page count, so we quote the estimate; after that we
  // report actual pages. An eight-page lease is ~1m45s, and saying so up front is
  // the difference between waiting and wondering whether it has hung.
  const autoStatus = (): string => {
    if (progress && progress.total > 0) {
      // Denominated in DOCUMENT pages, matching the "Page 4 of 8" indicator
      // beside it. Every page of a lease ends up with fields (initials at
      // minimum), so anything narrower reads as if pages were being skipped.
      const at = Math.min(progress.done + 1, progress.total)
      return `Analyzing page ${at} of ${progress.total}…`
    }
    return 'Reading the document…'
  }

  // S622: two boxes tagged with the same money column is a real defect — at
  // execution the lease builder now REFUSES to build rather than pick one
  // arbitrarily, and discovering that after everyone has signed is miserable.
  // Surface it here, while it is still a two-second fix.
  const duplicateMoneyTags = (() => {
    const byCol: Record<string, string[]> = {}
    for (const f of fields) {
      const col = f.leaseColumn
      if (!col) continue
      const cat = (LEASE_COLUMN_CATEGORY as Record<string, string>)[col]
      if (cat !== 'writable' && cat !== 'fee_row') continue
      ;(byCol[col] ||= []).push(f.label || col)
    }
    return Object.entries(byCol).filter(([, ls]) => ls.length > 1)
  })()

  // How deep a field sits: 0 top level, 1 inside an option, 2 inside that.
  // Walks the parent chain with a bound, so a cycle from hand-editing cannot
  // hang the editor.
  //
  // S622, corrected: an OPTION MARKER is a sibling, not a child. An election's
  // first option is the group field itself; options two onward hang off that
  // group so they can be conditional on it. Counting parent links therefore put
  // two options of the SAME choice at different depths — month-to-month looked
  // nested inside the very election it is half of, and "must vacate" looked a
  // level below "may continue". Nic spotted it from the rings alone: "the next
  // suboption has a purple ring, which shouldn't exist because it's at the same
  // depth level as the first suboption."
  //
  // A field whose own label IS the option it hangs on is that option's marker,
  // so it sits at its parent's depth. Anything else hanging on an option is a
  // field printed INSIDE that branch, and is one deeper.
  const depthOf = (f: any): number => {
    let d = 0, cur = f, guard = 0
    while (cur?.parentFieldId && guard++ < 8) {
      const parent = fields.find((x: any) => x.id === cur.parentFieldId)
      if (!parent) break
      const isOptionMarker =
        !!cur.parentOption && String(cur.label ?? '').trim() === String(cur.parentOption).trim()
      if (!isOptionMarker) d++
      cur = parent
    }
    return d
  }

  const pageFields = fields.filter(f => f.page === currentPage)
  const sel = getSelected()

  return (
    <div style={{ position:'fixed', inset:0, background:'var(--bg-0)', zIndex:1000, display:'flex', flexDirection:'column' }}>
      {/* Toolbar */}
      <div style={{ height:56, background:'var(--bg-1)', borderBottom:'1px solid var(--border-0)', display:'flex', alignItems:'center', padding:'0 16px', gap:12, flexShrink:0 }}>
        <button onClick={onClose} className="btn btn-ghost btn-sm"><X size={14} /> Close</button>
        <div style={{ flex:1, fontFamily:'var(--font-display)', fontSize:'.9rem', fontWeight:800, color:'var(--text-0)' }}>
          Template Editor — {template.name}
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:6 }}>
          <button className="btn btn-ghost btn-sm" onClick={() => setScale(s => Math.max(0.4, s - 0.1))} title="Zoom out">−</button>
          <span style={{ fontSize:'.72rem', color:'var(--text-3)', minWidth:36, textAlign:'center' as const }}>{Math.round(scale*100)}%</span>
          <button className="btn btn-ghost btn-sm" onClick={() => setScale(s => Math.min(1.8, s + 0.1))} title="Zoom in">+</button>
        </div>
        <div style={{ fontSize:'.72rem', color:'var(--text-3)' }}>Page {currentPage} of {template.pageCount}</div>
        {currentPage > 1 && <button className="btn btn-ghost btn-sm" onClick={() => setCurrentPage(p => p-1)}>← Prev</button>}
        {currentPage < template.pageCount && <button className="btn btn-ghost btn-sm" onClick={() => setCurrentPage(p => p+1)}>Next →</button>}
        <button className="btn btn-ghost btn-sm" onClick={undo} disabled={!canUndo}
          title="Undo (⌘Z)"><Undo2 size={13} /></button>
        <button className="btn btn-ghost btn-sm" onClick={redo} disabled={!canRedo}
          title="Redo (⇧⌘Z)"><Redo2 size={13} /></button>
        <button className="btn btn-primary btn-sm" onClick={handleAutoPlace} disabled={autoMut.isLoading}
          title={autoMut.isLoading ? 'Placement is running — you can keep this tab open' : `Detect and place field boxes from the lease PDF — ${AUTO_PLACE_ESTIMATE}`}>
          {autoMut.isLoading ? <><span className="spinner" /> Analyzing…</> : <>✨ Auto-place fields</>}
        </button>
        <button className="btn btn-primary btn-sm" onClick={() => saveMut.mutate()} disabled={saveMut.isLoading}>
          {saveMut.isLoading ? <span className="spinner" /> : <><Check size={13} /> Save Fields</>}
        </button>
      </div>

      {conditionalFees.length > 0 && (
        <div style={{
          padding:'8px 14px', background:'rgba(201,162,39,.10)',
          borderBottom:'1px solid rgba(201,162,39,.35)', fontSize:'.72rem',
          color:'var(--text-1)', lineHeight:1.5,
        }}>
          <b style={{ color:'var(--gold-1, #c9a227)' }}>Fees written into the lease text</b>
          <span style={{ color:'var(--text-3)' }}>
            {' '}— no blank to place a box on, so these are read from the wording. Each is
            charged only if you mark the condition failed at the move-out inspection.
          </span>
          {conditionalFees.map((c: any, i: number) => (
            <div key={i} style={{ marginTop:6, display:'flex', gap:8, alignItems:'flex-start' }}>
              <button className="btn btn-ghost btn-sm" title="Not a fee — remove"
                onClick={() => setConditionalFees(prev => prev.filter((_, j) => j !== i))}
                style={{ padding:'0 6px', lineHeight:1.2, flexShrink:0 }}>×</button>
              <div>
                <b>{c.label}</b> — ${Number(c.amount).toFixed(2)} at move-out
                <div style={{ color:'var(--text-3)', fontStyle:'italic', marginTop:1 }}>
                  “{String(c.conditionText).slice(0, 200)}{String(c.conditionText).length > 200 ? '…' : ''}”
                </div>
              </div>
            </div>
          ))}
          <div style={{ color:'var(--text-3)', marginTop:6 }}>
            Saved with the fields. Remove any the scan got wrong.
          </div>
        </div>
      )}

      {/* S622: the wait message used to sit INLINE between Auto-place and Save
          Fields, capped at 210px, where it wrapped into a cramped block that did
          not fit the space — Nic: "your message does not fit in the space
          provided... maybe you should make that message display as a header or a
          banner across the top of the screen. You have more room there."
          It is a full-width strip now, in the same stack as the other notices,
          and the button just says "Analyzing…". */}
      {autoMut.isLoading && (
        <div style={{
          padding:'10px 14px', background:'rgba(201,162,39,.10)',
          borderBottom:'1px solid rgba(201,162,39,.35)',
          display:'flex', alignItems:'center', gap:10,
          fontSize:'.76rem', color:'var(--text-1)', lineHeight:1.45,
        }}>
          <span className="spinner" style={{ flexShrink:0 }} />
          <div>
            <b>{autoStatus()}</b>{' '}
            <span style={{ color:'var(--text-3)' }}>
              Reading every page with the labeling model — {AUTO_PLACE_ESTIMATE}.
              Still faster than placing every box by hand, so leave this open and let it work.
            </span>
          </div>
        </div>
      )}

      {detection?.unstructured?.length > 0 && (
        <div style={{
          padding:'8px 14px', background:'rgba(74,158,255,.08)',
          borderBottom:'1px solid rgba(74,158,255,.3)', fontSize:'.72rem',
          color:'var(--text-1)', lineHeight:1.5,
        }}>
          <b style={{ color:'#4a9eff' }}>Reads like a choice — check these yourself</b>
          <span style={{ color:'var(--text-3)' }}>
            {' '}— the layout here isn’t one this reader understands, so no boxes were
            placed for it. If it IS a choice, add the boxes by hand and set what each
            one sits inside. Often it’s just wording, in which case ignore it.
          </span>
          {detection.unstructured.map((u: any, i: number) => (
            <div key={i} style={{ marginTop:6, display:'flex', gap:8, alignItems:'flex-start' }}>
              <button className="btn btn-ghost btn-sm" title="Not a choice — dismiss"
                onClick={() => setDetection((d: any) => ({ ...d, unstructured: d.unstructured.filter((_: any, j: number) => j !== i) }))}
                style={{ padding:'0 6px', lineHeight:1.2, flexShrink:0 }}>×</button>
              <div>
                <b>Page {u.page}</b> <span style={{ color:'var(--text-3)' }}>— {u.why}</span>
                <div style={{ color:'var(--text-3)', fontStyle:'italic', marginTop:1 }}>“{u.text}”</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {screeningFees.length > 0 && (
        <div style={{
          padding:'8px 14px', background:'rgba(74,158,255,.10)',
          borderBottom:'1px solid rgba(74,158,255,.35)', fontSize:'.72rem',
          color:'var(--text-1)', lineHeight:1.5,
        }}>
          <b style={{ color:'#4a9eff' }}>Background-check fee — found, and not billed</b>
          <span style={{ color:'var(--text-3)' }}>
            {' '}— {SCREENING_FEE_EXCLUSION_REASON} Billing it here would charge the
            tenant twice for one report, so GAM excludes it on purpose. Shown so you
            know it was seen, not missed.
          </span>
          {screeningFees.map((sf: any, i: number) => (
            <div key={i} style={{ marginTop:6 }}>
              <b>${Number(sf.amount).toFixed(2)}</b>
              <div style={{ color:'var(--text-3)', fontStyle:'italic', marginTop:1 }}>
                “{String(sf.context).slice(0, 200)}{String(sf.context).length > 200 ? '…' : ''}”
              </div>
            </div>
          ))}
        </div>
      )}

      {unattributed.length > 0 && (
        <div style={{
          padding:'8px 14px', background:'rgba(245,158,11,.10)',
          borderBottom:'1px solid rgba(245,158,11,.35)', fontSize:'.72rem',
          color:'var(--text-1)', lineHeight:1.5,
        }}>
          <b style={{ color:'#f59e0b' }}>Amounts your lease names that nothing is tracking</b>
          <span style={{ color:'var(--text-3)' }}>
            {' '}— GAM will not bill these. If one should be charged, tag the box for it
            with the matching fee type, or bill it as a one-off from the lease.
          </span>
          {unattributed.map((u: any, i: number) => (
            <div key={i} style={{ marginTop:6, display:'flex', gap:8, alignItems:'flex-start' }}>
              <button className="btn btn-ghost btn-sm" title="Not a charge — dismiss"
                onClick={() => setUnattributed(prev => prev.filter((_, j) => j !== i))}
                style={{ padding:'0 6px', lineHeight:1.2, flexShrink:0 }}>×</button>
              <div>
                <b>${Number(u.amount).toFixed(2)}</b>
                <div style={{ color:'var(--text-3)', fontStyle:'italic', marginTop:1 }}>
                  “{String(u.context).slice(0, 200)}{String(u.context).length > 200 ? '…' : ''}”
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {duplicateMoneyTags.length > 0 && (
        <div style={{
          padding:'8px 14px', background:'rgba(239,68,68,.10)',
          borderBottom:'1px solid rgba(239,68,68,.35)', fontSize:'.72rem',
          color:'var(--text-1)', lineHeight:1.45,
        }}>
          <b style={{ color:'#ef4444' }}>Two boxes are claiming the same amount.</b>{' '}
          {duplicateMoneyTags.map(([col, labels]) => (
            <span key={col}>
              <b>{LEASE_COLUMN_LABEL[col as keyof typeof LEASE_COLUMN_LABEL] || col}</b> is on {labels.length} boxes ({labels.join(', ')}).{' '}
            </span>
          ))}
          Leave the tag on the one box that STATES the amount and set the others to
          “None (static field)” — they will still print, they just will not bill twice.
        </div>
      )}

      <div style={{ flex:1, display:'flex', overflow:'hidden' }}>
        {/* Left panel — tools */}
        <div style={{ width:220, background:'var(--bg-1)', borderRight:'1px solid var(--border-0)', padding:16, overflowY:'auto', flexShrink:0 }}>
          <div style={{ fontSize:'.68rem', fontWeight:700, color:'var(--text-3)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:8 }}>Signer Role</div>
          <div style={{ display:'flex', flexDirection:'column', gap:4, marginBottom:16 }}>
            {SIGNER_ROLES.map(role => (
              <div key={role} onClick={() => setActiveRole(role)} style={{ padding:'6px 10px', borderRadius:6, cursor:'pointer', border:`1px solid ${activeRole===role?ROLE_COLORS[role]:'var(--border-0)'}`, background:activeRole===role?`${ROLE_COLORS[role]}22`:'transparent', fontSize:'.75rem', fontWeight:activeRole===role?700:400, color:activeRole===role?ROLE_COLORS[role]:'var(--text-3)', textTransform:'capitalize', display:'flex', alignItems:'center', gap:8 }}>
                {/* persistent color swatch — the legend for box colors on the page */}
                <span style={{ width:11, height:11, borderRadius:3, background:ROLE_COLORS[role]||'#888', flexShrink:0, border:'1px solid rgba(0,0,0,.2)' }} />
                {humanize(role)}
              </div>
            ))}
          </div>

          <div style={{ fontSize:'.68rem', fontWeight:700, color:'var(--text-3)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:8 }}>Field Type</div>
          <div style={{ display:'flex', flexDirection:'column', gap:4, marginBottom:16 }}>
            {FIELD_TYPES.map(ft => (
              <div key={ft.type} onClick={() => setActiveTool(activeTool===ft.type?null:ft.type)} style={{ padding:'8px 10px', borderRadius:6, cursor:'pointer', border:`1px solid ${activeTool===ft.type?ft.color:'var(--border-0)'}`, background:activeTool===ft.type?`${ft.color}22`:'transparent', display:'flex', alignItems:'center', gap:8, fontSize:'.75rem', fontWeight:activeTool===ft.type?700:400, color:activeTool===ft.type?ft.color:'var(--text-2)' }}>
                <span>{ft.icon}</span> {ft.label}
              </div>
            ))}
          </div>

            {/* S622: the rings need to say what they mean, or they are just
                decoration. Also points at HOW to nest by hand, which was only
                discoverable by selecting a field and finding the dropdown. */}
            <div style={{ padding:'8px 10px', background:'var(--bg-2)', border:'1px solid var(--border-0)', borderRadius:8, fontSize:'.7rem', color:'var(--text-3)', lineHeight:1.6, marginBottom:8 }}>
              <div style={{ fontWeight:700, color:'var(--text-2)', marginBottom:4 }}>Nesting</div>
              <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                <span style={{ width:11, height:11, borderRadius:3, border:'2px solid var(--text-3)' }} /> top level
              </div>
              <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                <span style={{ width:11, height:11, borderRadius:3, border:'2px solid var(--text-3)', boxShadow:'0 0 0 2px #4a9eff' }} /> inside an option
              </div>
              <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                <span style={{ width:11, height:11, borderRadius:3, border:'2px solid var(--text-3)', boxShadow:'0 0 0 2px #a78bfa' }} /> inside that one
              </div>
              <div style={{ marginTop:5 }}>Select a field to set or change what it sits inside.</div>
            </div>
          {activeTool && (
            <div style={{ padding:'8px 10px', background:'rgba(201,162,39,.08)', border:'1px solid rgba(201,162,39,.2)', borderRadius:8, fontSize:'.72rem', color:'var(--gold)', lineHeight:1.5 }}>
              Click on the document to place a <b>{FIELD_TYPES.find(f => f.type === activeTool)?.label || humanize(activeTool)}</b> field for <b>{humanize(activeRole)}</b>.
            </div>
          )}

          {/* Selected field properties */}
          {sel && isLockedLeaseColumn(sel.leaseColumn) && (
            <div style={{ marginTop:16, borderTop:'1px solid var(--border-0)', paddingTop:12 }}>
              <div style={{ fontSize:'.68rem', fontWeight:700, color:'var(--text-3)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:8 }}>Field Properties</div>
              <div style={{ padding:'10px 12px', background:'rgba(201,162,39,.08)', border:'1px solid rgba(201,162,39,.25)', borderRadius:8, fontSize:'.72rem', color:'var(--text-2)', lineHeight:1.5 }}>
                🔒 <b>{LEASE_COLUMN_LABEL[sel.leaseColumn as keyof typeof LEASE_COLUMN_LABEL] || sel.leaseColumn}</b> — locked.
                {sel.leaseColumn === 'rent_due_day' ? (
                  <> Rent is due on the <b>1st of each month</b> on every GAM lease — a mid-month move-in is prorated
                  automatically. This box stamps &ldquo;the 1st&rdquo; into the signed lease and can&apos;t be edited,
                  moved, or deleted; the landlord doesn&apos;t choose the due day.</>
                ) : (
                  <> Late fees come from the property&apos;s <b>Late Fees</b> policy for this unit type. The amount is
                  stamped into the lease at signing and can&apos;t be edited, moved, or deleted here — that keeps the
                  charge identical for every tenant of the class and matching the signed document. To change late
                  fees, update the property settings; changes apply to new leases at signing/renewal.</>
                )}
              </div>
            </div>
          )}
          {sel && !isLockedLeaseColumn(sel.leaseColumn) && (
            <div style={{ marginTop:16, borderTop:'1px solid var(--border-0)', paddingTop:12 }}>
              <div style={{ fontSize:'.68rem', fontWeight:700, color:'var(--text-3)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:8 }}>Field Properties</div>
              {/* S635 (Nic, DIRECTIVE): "the tenant names and the names of the
                  occupants both are landlord boxes, and those should be derived
                  from all the invites that went out."

                  An identity column is a fact GAM already holds — who is on the
                  lease, the unit, the property, the date. The VALUE was always
                  filled from the roster at send time, but the field still
                  carried a signer role, so the editor asked WHO FILLS THIS IN
                  about something nobody fills in — and auto-placement answered
                  "landlord" for all four tenant-name blanks. Unlike a locked
                  field this one is still ordinary furniture: move it, relabel
                  it, delete it. You just never fill it. */}
              {isAutoFilledLeaseColumn(sel.leaseColumn) && (
                <div style={{ marginBottom:8, padding:'8px 10px', background:'rgba(201,162,39,.07)',
                              border:'1px solid rgba(201,162,39,.22)', borderRadius:7,
                              fontSize:'.68rem', color:'var(--text-2)', lineHeight:1.45 }}>
                  Filled in automatically from the invite &mdash; nobody types this.
                  {sel.leaseColumn === 'occupant_names'
                    ? ' Everyone invited to the space, on one line, in household order.'
                    : ''}
                </div>
              )}
              {/* S629 (Nic): "give me a button to just change the role from one
                  person to the next."

                  Role could only be chosen when a field was CREATED, from the
                  tool palette. Auto-placement guesses it, and on the Oak Park
                  RV lease it guessed landlord for everything the TENANT knows —
                  RV make, model, license, length, width, state of registration,
                  everyone staying in it. There was no way to correct that: the
                  only route was delete the box and redraw it by hand, which
                  defeats the point of auto-placing it.

                  Placed first in the panel because on an auto-placed field it
                  is the thing most likely to be wrong. */}
              <div style={{ marginBottom:8, display: isAutoFilledLeaseColumn(sel.leaseColumn) ? 'none' : undefined }}>
                <label style={{ fontSize:'.65rem', color:'var(--text-3)', display:'block', marginBottom:3 }}>Who fills this in</label>
                <select className="input" value={sel.signerRole || ''}
                        onChange={e => updateSelected('signerRole', e.target.value)}
                        style={{ width:'100%', fontSize:'.75rem' }}>
                  {SIGNER_ROLES.map(role => (
                    <option key={role} value={role}>{humanize(role)}</option>
                  ))}
                </select>
                <div style={{ display:'flex', alignItems:'center', gap:6, fontSize:'.62rem', color:'var(--text-3)', marginTop:4 }}>
                  <span style={{ width:9, height:9, borderRadius:3, background:ROLE_COLORS[sel.signerRole]||'#888', flexShrink:0, border:'1px solid rgba(0,0,0,.2)' }} />
                  Changing this moves the box to that signer — it keeps its position, size and label.
                </div>
              </div>
              <div style={{ marginBottom:8 }}>
                <label style={{ fontSize:'.65rem', color:'var(--text-3)', display:'block', marginBottom:3 }}>Label</label>
                <input className="input" value={sel.label||''} onChange={e => updateSelected('label', e.target.value)} style={{ width:'100%', fontSize:'.75rem' }} />
              </div>
              <div style={{ fontSize:'.65rem', color:'var(--text-3)', marginBottom:8 }}>Drag edges to resize field</div>
              {(sel.fieldType === 'text' || sel.fieldType === 'date') && (
                <div style={{ marginBottom:8 }}>
                  <label style={{ fontSize:'.65rem', color:'var(--text-3)', display:'block', marginBottom:3 }}>Data label</label>
                  <select className="input" value={sel.leaseColumn||''} onChange={e => updateSelected('leaseColumn', e.target.value || null)} style={{ width:'100%', fontSize:'.75rem' }}>
                    <option value="">— None (static field) —</option>
                    {DATA_LABELS[sel.fieldType]?.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                  {(() => {
                    const eff = billingEffect(sel.leaseColumn)
                    return (
                      <div style={{ fontSize:'.62rem', marginTop:3, lineHeight:1.4,
                        color: eff.billing ? 'var(--gold-1, #c9a227)' : 'var(--text-3)' }}>
                        {eff.billing ? '💵 ' : ''}{eff.text}
                        {sel.leaseColumn ? ' Auto-filled from lease data at send time.' : ''}
                      </div>
                    )
                  })()}
                </div>
              )}
              {sel.fieldType === 'radio_group' && (
                <div style={{ marginBottom:8 }}>
                  <label style={{ fontSize:'.65rem', color:'var(--text-3)', display:'block', marginBottom:3 }}>Options (comma separated)</label>
                  <input className="input" value={sel.options||''} onChange={e => updateSelected('options', e.target.value)} placeholder="Yes, No" style={{ width:'100%', fontSize:'.75rem' }} />
                  <div style={{ fontSize:'.62rem', color:'var(--text-3)', marginTop:2 }}>One option must be selected</div>
                </div>
              )}
              {sel.fieldType === 'radio_group' && (
                <div style={{ marginBottom:8 }}>
                  <label style={{ fontSize:'.65rem', color:'var(--text-3)', display:'block', marginBottom:3 }}>Group Name</label>
                  <input className="input" value={sel.groupName||''} onChange={e => updateSelected('groupName', e.target.value)} placeholder="e.g. lease_type" style={{ width:'100%', fontSize:'.75rem' }} />
                </div>
              )}
              {/* S556: conditional visibility — ANY field can be shown/required
                  only when a radio equals a chosen option (e.g. end_date only
                  when lease_type = "Fixed term"; a notice-period field only when
                  = "Month-to-month"). Inapplicable fields auto-hide + drop their
                  required flag, so the landlord never marks N/A. */}
              {(() => {
                const candidates = fields.filter(x => x.fieldType === 'radio_group' && x.id !== sel.id)
                if (candidates.length === 0) return null
                const parent = candidates.find(x => x.id === sel.parentFieldId)
                const parentOpts = (parent?.options || '').split(',').map((o:string) => o.trim()).filter(Boolean)
                return (
                  <div style={{ marginBottom:8 }}>
                    <label style={{ fontSize:'.65rem', color:'var(--text-3)', display:'block', marginBottom:3 }}>Only show if…</label>
                    <select className="input" value={sel.parentFieldId || ''} onChange={e => { updateSelected('parentFieldId', e.target.value || null); updateSelected('parentOption', null) }} style={{ width:'100%', fontSize:'.75rem' }}>
                      <option value="">Always shown</option>
                      {candidates.map(c => <option key={c.id} value={c.id}>{c.label || c.groupName || 'Radio group'}</option>)}
                    </select>
                    {sel.parentFieldId && (
                      <select className="input" value={sel.parentOption || ''} onChange={e => updateSelected('parentOption', e.target.value || null)} style={{ width:'100%', fontSize:'.75rem', marginTop:4 }}>
                        <option value="">Pick trigger option…</option>
                        {parentOpts.map((o:string) => <option key={o} value={o}>{o}</option>)}
                      </select>
                    )}
                    {sel.parentFieldId && <div style={{ fontSize:'.62rem', color:'var(--text-3)', marginTop:2 }}>Shown + required only when that field equals this option.</div>}
                  </div>
                )
              })()}
              {sel.fieldType === 'initials' && template.pageCount > 1 && (
                <button
                  className="btn btn-ghost btn-sm"
                  style={{ width:'100%', justifyContent:'center', marginBottom:8, fontSize:'.7rem', color:'#ec4899', borderColor:'rgba(236,72,153,.3)' }}
                  onClick={() => {
                    const base = fields.find(f => f.id === selectedField)
                    if (!base) return
                    const existing = fields.filter(f => f.fieldType==='initials' && f.signerRole===base.signerRole && f.id!==base.id).map(f=>f.page)
                    const newFields = Array.from({ length: template.pageCount }, (_, i) => i+1)
                      .filter(pg => pg !== base.page && !existing.includes(pg))
                      .map(pg => ({ ...base, id: `f_${Date.now()}_${pg}`, page: pg }))
                    if (newFields.length === 0) return toast('Already stamped to all pages')
                    setFields(prev => [...prev, ...newFields])
                  }}>
                  🔘 Stamp to all {template.pageCount} pages
                </button>
              )}
              <label style={{ display:'flex', alignItems:'center', gap:6, cursor:'pointer', fontSize:'.72rem', color:'var(--text-2)' }}>
                <input type="checkbox" checked={sel.required} onChange={e => updateSelected('required', e.target.checked)} /> Required
              </label>
            </div>
          )}

          <div style={{ marginTop:16, borderTop:'1px solid var(--border-0)', paddingTop:12 }}>
            <div style={{ fontSize:'.68rem', fontWeight:700, color:'var(--text-3)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:8 }}>Fields ({fields.length})</div>
            {fields.map(f => {
              const ft = FIELD_TYPES.find(x => x.type === f.fieldType)
              return (
                <div key={f.id} onClick={() => { setSelectedField(f.id); setCurrentPage(f.page) }}
                  style={{ display:'flex', alignItems:'center', gap:6, padding:'4px 6px', borderRadius:5, cursor:'pointer', background:selectedField===f.id?'var(--bg-3)':'transparent', fontSize:'.7rem', color:'var(--text-2)', marginBottom:2 }}>
                  <span>{ft?.icon}</span>
                  <span style={{ flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{f.label} · p{f.page}</span>
                  <div style={{ width:8, height:8, borderRadius:'50%', background:ROLE_COLORS[f.signerRole]||'#888', flexShrink:0 }} />
                </div>
              )
            })}
          </div>
        </div>

        {/* PDF Canvas */}
        <div style={{ flex:1, overflow:'auto', background:'#2a2a2a', display:'flex', alignItems:'flex-start', justifyContent:'center', padding:20 }}>
          <div style={{ position:'relative', width: pdfW * scale, height: pdfH * scale, flexShrink:0 }}>
            {/* PDF background rendered with PDF.js */}
            {template.basePdfUrl ? (
              <PDFCanvas
                url={`${template.basePdfUrl.startsWith('http') ? '' : API_URL}${template.basePdfUrl}`}
                page={currentPage}
                width={pdfW * scale}
                height={pdfH * scale}
              />
            ) : (
              <div style={{ position:'absolute', inset:0, background:'#f5f5f0', display:'flex', alignItems:'center', justifyContent:'center', flexDirection:'column', gap:8 }}>
                <FileText size={48} style={{ color:'#ddd' }} />
                <div style={{ color:'#bbb', fontSize:'.8rem' }}>No PDF attached</div>
                <div style={{ color:'#bbb', fontSize:'.7rem' }}>Upload a PDF to this template to see it here</div>
              </div>
            )}

            {/* Click overlay */}
            <div ref={canvasRef} onClick={handleCanvasClick}
              style={{ position:'absolute', inset:0, cursor: activeTool ? 'crosshair' : 'default' }}>
              {pageFields.map(f => (
                <FieldItem key={f.id} field={f} selected={selectedField===f.id}
                  depth={depthOf(f)}
                  parentLabel={f.parentFieldId ? (fields.find((x: any) => x.id === f.parentFieldId)?.label ?? null) : null}
                  onSelect={setSelectedField} onMove={moveField}
                  onResize={resizeField}
                  onDelete={(id: string) => { setFields(prev => prev.filter(x => x.id !== id || isLockedLeaseColumn(x.leaseColumn))); setSelectedField(null) }}
                  scale={scale} />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── SEND DOCUMENT MODAL ────────────────────────────────────────────
function SendDocumentModal({ onClose }) {
  const qc = useQueryClient()
  const { user: authUser } = useAuth()
  const [templateId, setTemplateId] = useState('')
  // W-33 (S529): recipients resolve from the LEASE, not typed emails.
  // 'unit' — pick a unit, everyone on its active lease signs.
  // 'property' — one click sends one document per active lease at the property.
  // 'manual' — the escape hatch for non-tenant signers (old flow).
  const [mode, setMode] = useState<'unit'|'property'|'manual'>('unit')
  const [selectedUnitId, setSelectedUnitId] = useState('')
  const [selectedPropertyId, setSelectedPropertyId] = useState('')
  const [tenantEmails, setTenantEmails] = useState([''])
  const [tenantNames, setTenantNames] = useState([{ firstName: '', lastName: '' }])
  const [searches, setSearches] = useState([''])
  const [sending, setSending] = useState(false)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState('')
  const [prefillValues, setPrefillValues] = useState<Record<string,string>>({})
  // S604 (Nic): migration onboarding — the landlord ALREADY holds this tenant's
  // deposit. Without this, e-signing new leases for existing tenants bills every
  // one of them a fresh deposit (19 x $350 at Oak Park). The lease still STATES
  // the deposit; only the charge is suppressed.
  const [depositAlreadyHeld, setDepositAlreadyHeld] = useState(false)
  // S235: witness signer fields. Only surfaced when the picked template
  // has fields assigned to signerRole='witness'; otherwise hidden so the
  // common no-witness leases stay one-click.
  const [witnessFirst, setWitnessFirst] = useState('')
  const [witnessLast,  setWitnessLast]  = useState('')
  const [witnessEmail, setWitnessEmail] = useState('')
  const { data: templates = [] } = useQuery('esign-templates', () => apiGet('/esign/templates'))
  const { data: fullTemplate } = useQuery<any>(
    ['esign-template', templateId],
    () => apiGet(`/esign/templates/${templateId}`),
    { enabled: !!templateId }
  )
  const templateNeedsWitness: boolean = !!((fullTemplate?.fields || []) as any[])
    .some((f: any) => f.signerRole === 'witness')
  const uniqueBoundFields: any[] = Array.from(
    new Map(
      ((fullTemplate?.fields || []) as any[])
        .filter((f: any) => !!f.leaseColumn)
        .map((f: any) => [f.leaseColumn, f])
    ).values()
  )
  const onTemplateChange = (id: string) => { setTemplateId(id); setPrefillValues({}) }
  const { data: units = [] } = useQuery('units', () => apiGet('/units'))
  const existingTenants = units.filter(u => u.tenantEmail).map(u => ({ email: u.tenantEmail, name: u.tenantFirst + ' ' + u.tenantLast, unit: u.unitNumber, unitId: u.id, propertyName: u.propertyName }))
  const properties = Array.from(new Map((units as any[]).map(u => [u.propertyId, { id: u.propertyId, name: u.propertyName }])).values())
  const selectedTemplate = templates.find(t => t.id === templateId)

  // S535 auto-pull: picking a unit selects the template written for its
  // type (newest exact-type match, else universal) unless the current
  // pick is already compatible. Changeable in the picker either way.
  useEffect(() => {
    if (mode !== 'unit' || !selectedUnitId) return
    const u = (units as any[]).find((x:any) => x.id === selectedUnitId)
    if (!u?.unitType) return
    const fits = (t:any) => (!t.unitType || t.unitType === u.unitType) && (!t.propertyId || t.propertyId === u.propertyId)
    const current: any = templates.find((t:any) => t.id === templateId)
    if (current && fits(current)) return
    // Most specific first: locked to this property + exact type → exact
    // type → property-locked any-type → fully universal.
    const pool = (templates as any[]).filter(fits)
    const pick = pool.find((t:any) => t.propertyId === u.propertyId && t.unitType === u.unitType)
      ?? pool.find((t:any) => t.unitType === u.unitType)
      ?? pool.find((t:any) => t.propertyId === u.propertyId)
      ?? pool.find((t:any) => !t.unitType && !t.propertyId)
    if (pick) setTemplateId(pick.id)
  }, [selectedUnitId, mode])

  // S556/S558: pre-fill the Document Values form from the unit's data (rent,
  // unit #, property) so the landlord reviews/adjusts instead of retyping. The
  // derived security deposit needs the chosen template (deposit = rent ×
  // template.deposit_months, S558), so pass templateId and re-run when it
  // changes. Only fills blanks — anything already typed stays.
  useEffect(() => {
    if (mode !== 'unit' || !selectedUnitId) return
    let cancelled = false
    const qs = templateId ? `?templateId=${templateId}` : ''
    apiGet(`/esign/units/${selectedUnitId}/prefill-suggestions${qs}`)
      .then((s: Record<string,string>) => {
        if (cancelled || !s) return
        setPrefillValues(prev => {
          const next = { ...prev }
          for (const [k, v] of Object.entries(s)) if (v && !next[k]) next[k] = v
          return next
        })
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [selectedUnitId, mode, templateId])

  // Resolved lease signers for the picked unit / property.
  const recipientsQ = mode === 'unit' && selectedUnitId
    ? `/esign/recipients?unitId=${selectedUnitId}`
    : mode === 'property' && selectedPropertyId
      ? `/esign/recipients?propertyId=${selectedPropertyId}`
      : null
  const { data: recipientGroups = [], isLoading: recipientsLoading } = useQuery<any[]>(
    ['esign-recipients', recipientsQ],
    () => apiGet<any[]>(recipientsQ!),
    { enabled: !!recipientsQ }
  )

  const setEmail = (i, val) => { setTenantEmails(prev => prev.map((e,j) => j===i?val:e)); setSearches(prev => prev.map((e,j) => j===i?val:e)) }
  const selectTenant = (i, tenant) => { setTenantEmails(prev => prev.map((e,j) => j===i?tenant.email:e)); setSearches(prev => prev.map((e,j) => j===i?tenant.email:e)) }

  const validateWitness = (): boolean => {
    if (!templateNeedsWitness) return true
    if (!witnessEmail.trim()) { setError('This template requires a witness — enter their email'); return false }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(witnessEmail.trim())) { setError('Witness email is invalid'); return false }
    if (!witnessFirst.trim()) { setError('Witness first name required'); return false }
    return true
  }

  // Provision (once) + return the witness signer for a document, or null.
  const witnessSigner = async (orderIndex: number) => {
    if (!templateNeedsWitness || !witnessEmail.trim()) return null
    const wEmail = witnessEmail.trim()
    const wFirst = witnessFirst.trim() || wEmail.split('@')[0]
    const wLast  = witnessLast.trim()
    const provRes: any = await apiPost('/esign/witnesses/provision', { email: wEmail, firstName: wFirst, lastName: wLast })
    return { role: 'witness', name: (wFirst + ' ' + wLast).trim() || wEmail, email: wEmail, phone: null, orderIndex, userId: provRes.data.userId }
  }

  // Create + send ONE document for a resolved lease group. Landlord signs
  // first (orderIndex 1, S29 contract), then the lease's tenants, then any
  // witness. No invite/provision step — lease tenants already have accounts.
  const sendForGroup = async (group: any) => {
    const signers: any[] = [{
      role: 'landlord',
      name: (authUser.firstName + ' ' + authUser.lastName).trim(),
      email: authUser.email, phone: null, orderIndex: 1, userId: authUser.id,
    }]
    let order = 2
    for (const t of group.tenants) {
      signers.push({
        role: order === 2 ? 'primary' : 'co_tenant_' + (order - 2),
        name: `${t.firstName || ''} ${t.lastName || ''}`.trim() || t.email,
        email: t.email, phone: null, orderIndex: order, userId: t.userId, unitId: group.unitId,
      })
      order++
    }
    const w = await witnessSigner(order)
    if (w) signers.push(w)
    const title = (selectedTemplate ? selectedTemplate.name : 'Document') + ' — Unit ' + group.unitNumber
    const res = await apiPost('/esign/documents', { templateId, unitId: group.unitId, title, signers, prefillValues, depositAlreadyHeld })
    await apiPost('/esign/documents/' + res.data.id + '/send', {})
  }

  const handleSend = async () => {
    if (!templateId) { setError('Please select a template'); return }
    if (!authUser) { setError('Not logged in'); return }
    setError('')
    if (!validateWitness()) return

    if (mode === 'unit' || mode === 'property') {
      if (!recipientGroups.length) { setError('No active lease found there — nobody to send to.'); return }
      setSending(true)
      try {
        for (let i = 0; i < recipientGroups.length; i++) {
          setProgress(recipientGroups.length > 1 ? `Sending ${i + 1} of ${recipientGroups.length}…` : 'Sending…')
          await sendForGroup(recipientGroups[i])
        }
        qc.invalidateQueries('esign-documents')
        onClose()
      } catch (e: any) { setError(e.message || 'Failed to send') }
      setSending(false); setProgress('')
      return
    }

    // Manual escape hatch — provision each typed email like the old flow.
    const validEmails = tenantEmails.filter(e => e.trim())
    if (!validEmails.length) { setError('Please enter at least one email'); return }
    const firstTenant = existingTenants.find(t => t.email === validEmails[0].trim())
    setSending(true)
    try {
      const signers = []
      let order = 2
      for (let i = 0; i < validEmails.length; i++) {
        const email = validEmails[i].trim()
        const existing = existingTenants.find(t => t.email === email)
        const nameParts = existing
          ? { firstName: existing.name.split(' ')[0] || 'Tenant', lastName: existing.name.split(' ').slice(1).join(' ') || '' }
          : { firstName: (tenantNames[i]?.firstName || email.split('@')[0]), lastName: (tenantNames[i]?.lastName || '') }
        const inviteRes: any = await apiPost('/tenants/invite', {
          email, firstName: nameParts.firstName, lastName: nameParts.lastName,
          phone: null, unitId: firstTenant?.unitId || null,
        })
        signers.push({
          role: order === 2 ? 'primary' : 'co_tenant_' + (order - 2),
          name: (nameParts.firstName + ' ' + nameParts.lastName).trim() || email,
          email, phone: null, orderIndex: order, userId: inviteRes.data.userId,
          unitId: existing ? existing.unitId : (firstTenant?.unitId || null),
        })
        order++
      }
      signers.unshift({
        role: 'landlord',
        name: (authUser.firstName + ' ' + authUser.lastName).trim(),
        email: authUser.email, phone: null, orderIndex: 1, userId: authUser.id,
      })
      const w = await witnessSigner(order)
      if (w) signers.push(w)
      const unitId = firstTenant ? firstTenant.unitId : null
      const title = selectedTemplate ? selectedTemplate.name + (firstTenant ? ' — Unit ' + firstTenant.unit : '') : 'Lease Agreement'
      const res = await apiPost('/esign/documents', { templateId, unitId, title, signers, prefillValues })
      await apiPost('/esign/documents/' + res.data.id + '/send', {})
      qc.invalidateQueries('esign-documents')
      onClose()
    } catch(e: any) { setError(e.message || 'Failed to send') }
    setSending(false)
  }

  const totalSigners = recipientGroups.reduce((n: number, g: any) => n + g.tenants.length, 0)
  const canSend = !!templateId && (
    mode === 'unit' ? !!selectedUnitId && recipientGroups.length > 0 :
    mode === 'property' ? !!selectedPropertyId && recipientGroups.length > 0 :
    tenantEmails.some(e => e.trim())
  )

  return (
    <div className='modal-overlay' onClick={onClose}>
      <div className='modal' style={{ maxWidth:480 }} onClick={e => e.stopPropagation()}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
          <div className='modal-title' style={{ marginBottom:0 }}>Send Document</div>
          <button className='btn btn-ghost btn-sm' onClick={onClose}><X size={14} /></button>
        </div>
        <div style={{ marginBottom:16 }}>
          <label style={{ fontSize:'.72rem', fontWeight:600, color:'var(--text-3)', textTransform:'uppercase', letterSpacing:'.06em', display:'block', marginBottom:6 }}>Template *</label>
          <select className='input' style={{ width:'100%' }} value={templateId} onChange={e => onTemplateChange(e.target.value)} autoFocus>
            <option value=''>Select a template…</option>
            {templates.map(t => <option key={t.id} value={t.id}>{t.name}{t.purpose === 'work_trade_addendum' ? ' · Addendum' : ''} ({t.fieldCount} fields)</option>)}
          </select>
          {/* S576 (B-8): an addendum template AMENDS the existing lease — it never
              spins up a new one. Make that explicit so the landlord isn't surprised. */}
          {selectedTemplate?.purpose === 'work_trade_addendum' && (
            <div style={{ fontSize:'.7rem', color:'var(--gold)', marginTop:5 }}>
              This is an addendum — it amends the recipients' active lease (no new lease is created).
            </div>
          )}
        </div>

        {/* W-33: recipient mode — unit (default) / whole property / manual */}
        <div style={{ marginBottom:12 }}>
          <label style={{ fontSize:'.72rem', fontWeight:600, color:'var(--text-3)', textTransform:'uppercase', letterSpacing:'.06em', display:'block', marginBottom:6 }}>Send To *</label>
          <div style={{ display:'flex', gap:6 }}>
            {([['unit','A Unit'],['property','Whole Property'],['manual','Specific Emails']] as const).map(([m, label]) => (
              <button key={m} type='button' className={`btn btn-sm ${mode===m?'btn-primary':'btn-ghost'}`} onClick={() => { setMode(m); setError('') }}>
                {label}
              </button>
            ))}
          </div>
        </div>

        {mode === 'unit' && (
          <div style={{ marginBottom:16 }}>
            <select className='input' style={{ width:'100%' }} value={selectedUnitId} onChange={e => setSelectedUnitId(e.target.value)}>
              <option value=''>Pick a unit…</option>
              {(units as any[]).map(u => <option key={u.id} value={u.id}>{u.unitNumber} · {u.propertyName}</option>)}
            </select>
            {selectedUnitId && !recipientsLoading && (
              recipientGroups.length ? (
                <div style={{ fontSize:'.74rem', color:'var(--green)', marginTop:6, lineHeight:1.6 }}>
                  {recipientGroups[0].tenants.map((t: any) => (
                    <div key={t.userId}>✓ {`${t.firstName||''} ${t.lastName||''}`.trim()} · {t.email}{t.role==='primary' ? '' : ' (co-tenant)'}</div>
                  ))}
                  <div style={{ color:'var(--text-3)' }}>Everyone on this unit's lease signs.</div>
                </div>
              ) : (
                <div style={{ fontSize:'.72rem', color:'var(--amber)', marginTop:6 }}>No active lease on that unit — use Specific Emails if you need to send anyway.</div>
              )
            )}
          </div>
        )}

        {mode === 'property' && (
          <div style={{ marginBottom:16 }}>
            <select className='input' style={{ width:'100%' }} value={selectedPropertyId} onChange={e => setSelectedPropertyId(e.target.value)}>
              <option value=''>Pick a property…</option>
              {properties.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            {selectedPropertyId && !recipientsLoading && (
              recipientGroups.length ? (
                <div style={{ fontSize:'.74rem', color:'var(--green)', marginTop:6 }}>
                  ✓ {recipientGroups.length} lease{recipientGroups.length===1?'':'s'} · {totalSigners} tenant signer{totalSigners===1?'':'s'} — each lease gets its own document to sign.
                </div>
              ) : (
                <div style={{ fontSize:'.72rem', color:'var(--amber)', marginTop:6 }}>No active leases at that property.</div>
              )
            )}
          </div>
        )}

        {mode === 'manual' && (
          <div style={{ marginBottom:16 }}>
            {tenantEmails.map((email, i) => {
              const filtered = searches[i] ? existingTenants.filter(t => t.email.includes(searches[i]) || t.name.toLowerCase().includes(searches[i].toLowerCase())) : []
              const matched = existingTenants.find(t => t.email === email)
              return (
                <div key={i} style={{ marginBottom:8, position:'relative' }}>
                  <div style={{ display:'flex', gap:6 }}>
                    <input className='input' placeholder='someone@email.com' value={searches[i]} onChange={e => setEmail(i, e.target.value)} style={{ flex:1, borderColor: matched ? 'var(--green)' : undefined }} />
                    {tenantEmails.length > 1 && <button className='btn btn-ghost btn-sm' style={{ color:'var(--red)' }} onClick={() => { setTenantEmails(prev => prev.filter((_,j)=>j!==i)); setSearches(prev => prev.filter((_,j)=>j!==i)) }}><X size={12} /></button>}
                  </div>
                  {matched && <div style={{ fontSize:'.68rem', color:'var(--green)', marginTop:3 }}>✓ {matched.name} · Unit {matched.unit} · {matched.propertyName}</div>}
                  {!matched && filtered.length > 0 && searches[i] && (
                    <div style={{ position:'absolute', top:'100%', left:0, right:0, background:'var(--bg-1)', border:'1px solid var(--border-0)', borderRadius:8, zIndex:50, overflow:'hidden', boxShadow:'0 4px 16px rgba(0,0,0,.3)' }}>
                      {filtered.slice(0,4).map(t => (
                        <div key={t.email} onClick={() => selectTenant(i, t)} style={{ padding:'8px 12px', cursor:'pointer', fontSize:'.78rem', borderBottom:'1px solid var(--border-0)' }} onMouseEnter={e => e.currentTarget.style.background='var(--bg-2)'} onMouseLeave={e => e.currentTarget.style.background=''}><div style={{ fontWeight:600, color:'var(--text-0)' }}>{t.name}</div><div style={{ color:'var(--text-3)', fontSize:'.68rem' }}>{t.email} · Unit {t.unit}</div></div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
            <button className='btn btn-ghost btn-sm' onClick={() => { setTenantEmails(prev => [...prev,'']); setSearches(prev => [...prev,'']) }}><Plus size={12} /> Add Another Signer</button>
          </div>
        )}

        {templateNeedsWitness && (
          <div style={{ marginBottom:16, padding:'12px 14px', background:'rgba(245,158,11,.08)', border:'1px solid rgba(245,158,11,.25)', borderRadius:10 }}>
            <label style={{ fontSize:'.72rem', fontWeight:600, color:'var(--text-3)', textTransform:'uppercase', letterSpacing:'.06em', display:'block', marginBottom:6 }}>Witness *</label>
            <div style={{ fontSize:'.72rem', color:'var(--text-3)', marginBottom:8, lineHeight:1.45 }}>
              This template has fields assigned to a witness. They sign after all tenants and receive an email with the link.
            </div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6, marginBottom:6 }}>
              <input className='input' placeholder='First name' value={witnessFirst} onChange={e => setWitnessFirst(e.target.value)} />
              <input className='input' placeholder='Last name (optional)' value={witnessLast} onChange={e => setWitnessLast(e.target.value)} />
            </div>
            <input className='input' style={{ width:'100%' }} placeholder='witness@email.com' type='email' value={witnessEmail} onChange={e => setWitnessEmail(e.target.value)} />
          </div>
        )}
        {uniqueBoundFields.length > 0 && (
          <div style={{ marginBottom:16 }}>
            <label style={{ fontSize:'.72rem', fontWeight:600, color:'var(--text-3)', textTransform:'uppercase', letterSpacing:'.06em', display:'block', marginBottom:6 }}>Document Values</label>
            <div style={{ padding:'10px 12px', background:'var(--bg-2)', border:'1px solid var(--border-0)', borderRadius:10, display:'flex', flexDirection:'column', gap:8 }}>
              {uniqueBoundFields.map((f: any) => {
                const meta = (DATA_LABELS[f.fieldType] || []).find((o: any) => o.value === f.leaseColumn)
                const niceLabel = meta ? meta.label : f.leaseColumn
                const inputType = f.fieldType === 'date' ? 'date' : 'text'
                return (
                  <div key={f.leaseColumn}>
                    <label style={{ fontSize:'.68rem', color:'var(--text-3)', display:'block', marginBottom:2 }}>{niceLabel}</label>
                    <input className='input' type={inputType} value={prefillValues[f.leaseColumn] || ''} onChange={e => setPrefillValues(prev => ({ ...prev, [f.leaseColumn]: e.target.value }))} style={{ width:'100%', fontSize:'.78rem' }} />
                  </div>
                )
              })}
              <div style={{ fontSize:'.62rem', color:'var(--text-3)', marginTop:2 }}>Blank values can be left for the signer to fill in.</div>
            </div>
          </div>
        )}
        {/* S604 (Nic): migration onboarding. Existing tenants signing a NEW GAM
            lease must not be re-billed a deposit the landlord already holds. */}
        <div style={{ marginBottom: 12, padding: '10px 12px', background: 'var(--bg-2)',
                      borderRadius: 8, border: `1px solid ${depositAlreadyHeld ? 'var(--gold)' : 'var(--border-0)'}` }}>
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
            <input type="checkbox" checked={depositAlreadyHeld}
              onChange={e => setDepositAlreadyHeld(e.target.checked)} style={{ marginTop: 2 }} />
            <span>
              <span style={{ fontSize: '.8rem', fontWeight: 600, color: 'var(--text-0)' }}>
                Security deposit is already held
              </span>
              <span style={{ display: 'block', fontSize: '.72rem', color: 'var(--text-3)', marginTop: 2, lineHeight: 1.5 }}>
                For existing tenants moving onto GAM. The lease still states the deposit amount,
                but the tenant is <strong>not billed</strong> for it — it&apos;s recorded as already
                collected and held by you. Leave unchecked for a genuinely new tenant.
              </span>
            </span>
          </label>
        </div>
        {error && <div style={{ color:'var(--red)', fontSize:'.75rem', marginBottom:10 }}>{error}</div>}
        {progress && <div style={{ color:'var(--gold)', fontSize:'.75rem', marginBottom:10 }}>{progress}</div>}
        <div className='modal-footer'>
          <button className='btn btn-ghost' onClick={onClose}>Cancel</button>
          <button className='btn btn-primary' disabled={sending || !canSend} onClick={handleSend}>
            {sending ? <span className='spinner' /> : <><Send size={14} /> {mode === 'property' && recipientGroups.length > 1 ? `Send to ${recipientGroups.length} Leases` : 'Send for Signing'}</>}
          </button>
        </div>
      </div>
    </div>
  )
}

// S568 (Nic): create + send a STANDALONE document (purchase agreement, bill of
// sale, contract) with arbitrary signers/roles. Any signer emailed who isn't
// already a GAM user is minted a free 'contact' account (customer pool) and
// invited to activate + sign — no raw-email delivery. Reuses the generic e-sign
// engine (a template supplies the signable fields).
function StandaloneDocModal({ templates, onClose, onDone }: { templates: any[]; onClose: () => void; onDone: () => void }) {
  const [docType, setDocType] = useState<string>(STANDALONE_DOCUMENT_TYPES[0])
  const [title, setTitle] = useState('')
  const [templateId, setTemplateId] = useState('')
  const [signers, setSigners] = useState<Array<{ name: string; email: string; role: string }>>([
    { name: '', email: '', role: 'seller' },
    { name: '', email: '', role: 'purchaser' },
  ])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const setSigner = (i: number, patch: Partial<{ name: string; email: string; role: string }>) =>
    setSigners(prev => prev.map((s, j) => j === i ? { ...s, ...patch } : s))

  const roleOptions = GENERIC_SIGNER_ROLES
  const validEmails = signers.every(s => /.+@.+\..+/.test(s.email) && s.name.trim())
  const distinctRoles = new Set(signers.map(s => s.role)).size === signers.length
  const canSubmit = title.trim() && templateId && signers.length >= 1 && validEmails && distinctRoles && !busy

  const submit = async () => {
    setBusy(true); setError('')
    try {
      const created: any = await apiPost('/esign/standalone-documents', {
        title: title.trim(), documentType: docType, templateId,
        signers: signers.map(s => ({ name: s.name.trim(), email: s.email.trim(), role: s.role })),
      })
      // Send it so signers get their activate-and-sign invite.
      await apiPost(`/esign/documents/${created.data.id}/send`, {})
      toast('Contract created and sent for signature.')
      onDone()
    } catch (e: any) {
      setError(e?.response?.data?.message || e?.message || 'Could not create the document.')
    } finally { setBusy(false) }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 600, width: '95vw', maxHeight: '90vh', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title" style={{ marginBottom: 0 }}>New Contract</div>
          <button className="btn btn-ghost btn-sm" onClick={onClose}><X size={14} /></button>
        </div>
        <div style={{ padding: '4px 20px 20px', display: 'grid', gap: 12 }}>
          <label style={{ fontSize: '.75rem', color: 'var(--text-3)' }}>Document type
            <select className="form-input" value={docType} onChange={e => setDocType(e.target.value)}>
              {STANDALONE_DOCUMENT_TYPES.map(t => <option key={t} value={t}>{LEASE_DOCUMENT_TYPE_LABEL[t]}</option>)}
            </select>
          </label>
          <label style={{ fontSize: '.75rem', color: 'var(--text-3)' }}>Title
            <input className="form-input" value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Home purchase agreement — Unit 12" />
          </label>
          <label style={{ fontSize: '.75rem', color: 'var(--text-3)' }}>Template (supplies the signature fields)
            <select className="form-input" value={templateId} onChange={e => setTemplateId(e.target.value)}>
              <option value="">Select a template…</option>
              {templates.map((t: any) => <option key={t.id} value={t.id}>{t.name} ({t.fieldCount} fields)</option>)}
            </select>
            {templates.length === 0 && (
              <span style={{ fontSize: '.7rem', color: 'var(--amber)' }}>No templates yet — build one in the Templates tab (add seller/purchaser fields), then come back.</span>
            )}
          </label>

          <div>
            <div style={{ fontSize: '.72rem', fontWeight: 700, color: 'var(--gold)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>Signers</div>
            <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginBottom: 8 }}>
              Anyone without a GAM account gets a free account + an invite to activate and sign — nothing is emailed to an unverified address.
            </div>
            {signers.map((s, i) => (
              <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' }}>
                <select className="form-input" style={{ width: 120, fontSize: '.78rem' }} value={s.role} onChange={e => setSigner(i, { role: e.target.value })}>
                  {roleOptions.map(r => <option key={r} value={r}>{GENERIC_SIGNER_ROLE_LABEL[r]}</option>)}
                </select>
                <input className="form-input" style={{ flex: 1, fontSize: '.78rem' }} placeholder="Full name" value={s.name} onChange={e => setSigner(i, { name: e.target.value })} />
                <input className="form-input" style={{ flex: 1.3, fontSize: '.78rem' }} placeholder="Email" value={s.email} onChange={e => setSigner(i, { email: e.target.value })} />
                {signers.length > 1 && <button className="btn btn-ghost btn-sm" style={{ padding: 4 }} onClick={() => setSigners(prev => prev.filter((_, j) => j !== i))}><X size={13} /></button>}
              </div>
            ))}
            {signers.length < 6 && (
              <button className="btn btn-ghost btn-sm" style={{ padding: '2px 8px', fontSize: '.72rem' }}
                onClick={() => setSigners(prev => [...prev, { name: '', email: '', role: 'party_1' }])}><Plus size={12} /> Add signer</button>
            )}
            {!distinctRoles && <div style={{ fontSize: '.7rem', color: 'var(--amber)', marginTop: 4 }}>Each signer needs a distinct role.</div>}
          </div>

          {error && <div style={{ fontSize: '.75rem', color: 'var(--red)' }}>{error}</div>}
        </div>
        <div className="modal-footer" style={{ padding: '0 20px 20px', display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!canSubmit} onClick={submit}>{busy ? 'Sending…' : 'Create & Send'}</button>
        </div>
      </div>
    </div>
  )
}

export function ESignPage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { can } = usePerms()
  const [tab, setTab]           = useState<'documents'|'templates'>('documents')
  const [editTemplate, setEditTemplate] = useState<any>(null)
  const [showSend, setShowSend] = useState(false)
  const [showStandalone, setShowStandalone] = useState(false)
  const [showNewTemplate, setShowNewTemplate] = useState(false)
  const [newTmplName, setNewTmplName] = useState('')
  // S576 (B-8): template purpose — 'lease' (default) or 'work_trade_addendum'
  // (the landlord's own work-trade addendum form).
  const [newTmplPurpose, setNewTmplPurpose] = useState('lease')
  // S535: templates are per unit type ('' = universal)
  const [newTmplUnitType, setNewTmplUnitType] = useState('')
  // S535: optional PROPERTY lock — auto-set when the uploaded PDF's text
  // names exactly one of the landlord's properties.
  const [newTmplPropertyId, setNewTmplPropertyId] = useState('')
  // S558: deposit multiplier the lease STATES ('' = none → landlord fills the
  // deposit manually). deposit = unit rent × this, auto-filled at draft.
  const [newTmplDepositMonths, setNewTmplDepositMonths] = useState('')
  // S558: default lease term ('' = month-to-month; N = fixed N-month term).
  const [newTmplTermMonths, setNewTmplTermMonths] = useState('')
  const [detectedPropertyName, setDetectedPropertyName] = useState<string | null>(null)
  const { data: tmplProperties = [] } = useQuery<any[]>('properties', () => apiGet('/properties'))
  const [newTmplPdf, setNewTmplPdf] = useState('')
  const [tmplUploading, setTmplUploading] = useState(false)
  const [tmplUploadedName, setTmplUploadedName] = useState('')
  const [tmplPageCount, setTmplPageCount] = useState(1)

  // S629 (Nic): "when I'm on the gold sign page and I click on templates, it
  // shows me all the templates for all the different properties I have. It
  // needs to filter by which property I'm planning on using."
  //
  // The endpoint has narrowed by ?propertyId since S535 — nothing on this tab
  // ever asked it to. Templates with no property are portfolio-wide and stay
  // visible at every property, which is what the server already does.
  const [tmplPropertyId, setTmplPropertyId] = useState('')
  const { data: templates = [], isLoading: tmplLoading } = useQuery<any[]>(
    ['esign-templates', tmplPropertyId],
    () => apiGet(`/esign/templates${tmplPropertyId ? `?propertyId=${tmplPropertyId}` : ''}`))
  const { data: documents = [], isLoading: docLoading  } = useQuery<any[]>('esign-documents',  () => apiGet('/esign/documents'))

  // S576: search + property dropdown over the Documents tab. Keys on
  // propertyName (the docs payload has no propertyId); standalone contracts
  // have no property and fall out of a property-filtered view by design.
  const [docSearch, setDocSearch] = useState('')
  const [docPropertyName, setDocPropertyName] = useState('')
  const docPropertyOptions = (documents as any[]).map(d => ({ id: d.propertyName, name: d.propertyName }))
  const dq = docSearch.trim().toLowerCase()
  const filteredDocs = (documents as any[]).filter(d => {
    const matchProperty = docPropertyName === '' || d.propertyName === docPropertyName
    if (!matchProperty) return false
    if (dq === '') return true
    return (d.title || '').toLowerCase().includes(dq)
      || (d.unitNumber || '').toLowerCase().includes(dq)
      || (d.propertyName || '').toLowerCase().includes(dq)
      || (d.documentType ? humanize(d.documentType).toLowerCase().includes(dq) : false)
  })

  const deleteTemplateMut = useMutation(
    (id: string) => apiDelete('/esign/templates/' + id),
    { onSuccess: () => qc.invalidateQueries('esign-templates') }
  )

  // S558: designate a template as its unit type's default (the "primary
  // <unit type> lease"). Server clears any prior default for the same
  // (unit type, property) — radio behaviour.
  const setDefaultTemplateMut = useMutation(
    (id: string) => apiPost(`/esign/templates/${id}/set-default`, { isDefault: true }),
    { onSuccess: () => qc.invalidateQueries('esign-templates'),
      onError: (e: any) => toast.error(e?.message || 'Could not set default') }
  )

  const createTemplateMut = useMutation(
    () => apiPost('/esign/templates', { name: newTmplName, pageCount: tmplPageCount, basePdfUrl: newTmplPdf||null, purpose: newTmplPurpose, unitType: newTmplUnitType === 'all' ? null : newTmplUnitType || null, propertyId: newTmplPropertyId || null, depositMonths: newTmplDepositMonths === '' ? null : Number(newTmplDepositMonths), defaultTermMonths: newTmplTermMonths === '' ? null : Number(newTmplTermMonths) }),
    { onSuccess: async (res: any) => {
      qc.invalidateQueries('esign-templates')
      setShowNewTemplate(false)
      // Open editor immediately
      const full = await apiGet<any>(`/esign/templates/${(res as any).data.id}`)
      setEditTemplate(full)
    }}
  )

  const voidMut = useMutation(
    (id: string) => apiPost(`/esign/documents/${id}/void`, { reason: 'Voided by landlord' }),
    { onSuccess: () => qc.invalidateQueries('esign-documents') }
  )

  const STATUS_COLORS: Record<string,string> = {
    draft:'badge-muted', sent:'badge-blue', in_progress:'badge-amber',
    completed:'badge-green', voided:'badge-red'
  }

  // Per-user tab gating (canonical POSPage pattern): staff see only the tabs
  // they hold; owners see both. Snap the active tab to the first visible one
  // if the current tab is hidden for this user.
  const TABS = [
    { id:'documents', label:'Documents', perm:'esign.tab.documents' },
    { id:'templates', label:'Templates', perm:'esign.tab.templates' },
  ].filter(t => can(t.perm))
  const visibleTabIds = TABS.map(t => t.id).join(',')
  useEffect(() => {
    if (TABS.length && !TABS.some(t => t.id === tab)) setTab(TABS[0].id as any)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleTabIds])

  if (editTemplate) return <TemplateEditor template={editTemplate} onClose={() => setEditTemplate(null)} />

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">GoldSign</h1>
          <p className="page-subtitle">Send documents for electronic signature</p>
        </div>
        <div style={{ display:'flex', gap:8 }}>
          {tab === 'documents' && can('esign.template_manage') && <button className="btn btn-ghost" onClick={() => setShowStandalone(true)} title="Purchase agreement, bill of sale, or other contract with any signers"><FileText size={15} /> New Contract</button>}
          {tab === 'documents' && can('esign.send') && <button className="btn btn-primary" onClick={() => setShowSend(true)}><Send size={15} /> Send Document</button>}
          {tab === 'templates' && can('esign.template_manage') && <button className="btn btn-primary" onClick={() => setShowNewTemplate(true)}><Plus size={15} /> New Template</button>}
        </div>
      </div>

      <div style={{ display:'flex', gap:8, marginBottom:20 }}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id as any)} className={`btn btn-sm ${tab===t.id?'btn-primary':'btn-ghost'}`}>{t.label}</button>
        ))}
      </div>

      {/* Documents */}
      {tab === 'documents' && (documents as any[]).length > 0 && (
        <div className="filter-bar">
          <SearchBox value={docSearch} onChange={setDocSearch} placeholder="Search document, unit, property…" />
          <PropertySelect value={docPropertyName} onChange={setDocPropertyName} properties={docPropertyOptions} />
        </div>
      )}

      {/* Documents */}
      {tab === 'documents' && (
        <div className="card" style={{ padding:0 }}>
          {docLoading ? <div style={{ padding:32, textAlign:'center', color:'var(--text-3)' }}>Loading…</div> :
           (documents as any[]).length === 0 ? (
            <div className="empty-state" style={{ padding:48 }}>
              <FileText size={40} />
              <h3>No documents yet</h3>
              <p>Send your first document for signature.</p>
              {can('esign.send') && <button className="btn btn-primary" onClick={() => setShowSend(true)}><Send size={14} /> Send Document</button>}
            </div>
          ) : (
            <table className="data-table">
              <thead><tr><th>Document</th><th>Unit</th><th>Status</th><th>Signers</th><th>Sent</th><th>Completed</th><th></th></tr></thead>
              <tbody>
                {filteredDocs.length === 0 ? (
                  <tr><td colSpan={7} style={{ textAlign:'center', color:'var(--text-3)', padding:32 }}>No documents match your filters.</td></tr>
                ) : filteredDocs.map(d => (
                  <tr key={d.id}>
                    <td style={{ fontWeight:600, color:'var(--text-0)' }}>{d.title}</td>
                    <td style={{ fontSize:'.75rem' }}>{d.unitNumber ? `${d.propertyName} · Unit ${d.unitNumber}` : (d.documentType ? humanize(d.documentType) : '—')}</td>
                    <td><span className={`badge ${STATUS_COLORS[d.status]||'badge-muted'}`}>{humanize(d.status)}</span></td>
                    <td style={{ fontSize:'.75rem' }}>{d.signedCount}/{d.signerCount} signed</td>
                    <td style={{ fontSize:'.72rem', color:'var(--text-3)' }}>{d.sentAt ? new Date(d.sentAt).toLocaleDateString() : '—'}</td>
                    <td style={{ fontSize:'.72rem', color: d.completedAt ? 'var(--green)' : 'var(--text-3)' }}>{d.completedAt ? new Date(d.completedAt).toLocaleDateString() : '—'}</td>
                    <td>
                      <div style={{ display:'flex', gap:6 }}>
                        {/* S632 (Nic): "Where as the landlord can I sign the
                            lease inside the app?" Nowhere — this table offered
                            Download and Void and nothing else, so a lease
                            waiting on the landlord's own signature had no way
                            in except an emailed link. */}
                        {d.landlordMustSign && d.status !== 'voided' && (
                          <button className="btn btn-primary btn-sm"
                            onClick={() => navigate(`/sign/${d.id}`)}>
                            <PenLine size={12} /> Sign
                          </button>
                        )}
                        {can('esign.download') && d.executedPdfUrl && <a href={d.executedPdfUrl} className="btn btn-ghost btn-sm"><Download size={12} /></a>}
                        {can('esign.void') && d.status !== 'completed' && d.status !== 'voided' && (
                          <button className="btn btn-ghost btn-sm" style={{ color:'var(--red)' }} onClick={() => { appConfirm('Void this document?', { danger: true, confirmLabel: 'Void' }).then(ok => { if (ok) voidMut.mutate(d.id) }) }}><X size={12} /></button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Templates */}
      {tab === 'templates' && (
        <div>
          {(tmplProperties as any[]).length > 1 && (
            <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:14, flexWrap:'wrap' }}>
              <label className="form-label" style={{ margin:0, fontSize:'.72rem' }}>Property</label>
              <select className="input" style={{ width:'auto', minWidth:240 }}
                      value={tmplPropertyId} onChange={e => setTmplPropertyId(e.target.value)}>
                <option value="">All properties</option>
                {(tmplProperties as any[]).map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              <span style={{ fontSize:'.7rem', color:'var(--text-3)' }}>
                Templates set to one property, plus any that apply everywhere.
              </span>
            </div>
          )}
          {tmplLoading ? <div style={{ padding:32, textAlign:'center', color:'var(--text-3)' }}>Loading…</div> :
          (templates as any[]).length === 0 ? (
            <div className="empty-state" style={{ padding:48 }}>
              <FileText size={40} />
              <h3>No templates yet</h3>
              <p>Create a template to define reusable signature fields.</p>
              {can('esign.template_manage') && <button className="btn btn-primary" onClick={() => setShowNewTemplate(true)}><Plus size={14} /> New Template</button>}
            </div>
          ) : (
            <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(260px,1fr))', gap:12 }}>
              {(templates as any[]).map(t => (
                <div key={t.id} className="card" style={{ padding:'16px' }}>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:10 }}>
                    <div>
                      <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:2 }}>
                        <span style={{ fontWeight:700, color:'var(--text-0)' }}>{t.name}</span>
                        {t.purpose === 'work_trade_addendum' && (
                          <span title="Attaches to a renewal when a work-trade tenant needs a fresh tenancy" style={{ fontSize:'.6rem', fontWeight:700, textTransform:'uppercase' as const, letterSpacing:'.05em', color:'var(--text-1)', border:'1px solid var(--border-1)', borderRadius:4, padding:'1px 5px' }}>Work-Trade Addendum</span>
                        )}
                        {t.isUnitTypeDefault && (
                          <span title={`Default lease for ${t.unitType ? humanize(t.unitType) : 'this unit type'}`} style={{ fontSize:'.6rem', fontWeight:700, textTransform:'uppercase' as const, letterSpacing:'.05em', color:'var(--gold)', border:'1px solid var(--gold)', borderRadius:4, padding:'1px 5px' }}>Default</span>
                        )}
                      </div>
                      <div style={{ fontSize:'.72rem', color:'var(--text-3)' }}>{t.fieldCount} fields · {t.pageCount} pages · {t.unitType ? humanize(t.unitType) : 'any unit type'} · {t.propertyName || 'any property'}</div>
                      {t.purpose !== 'work_trade_addendum' && (
                        <div style={{ fontSize:'.72rem', color:'var(--text-3)', marginTop:2 }}>
                          {t.defaultTermMonths ? `${t.defaultTermMonths}-mo term` : 'Month-to-month'}
                          {t.depositMonths != null ? ` · deposit ${Number(t.depositMonths)}× rent` : ' · deposit set on lease'}
                        </div>
                      )}
                    </div>
                    <FileText size={18} style={{ color:'var(--text-3)' }} />
                  </div>
                  {t.description && <div style={{ fontSize:'.75rem', color:'var(--text-3)', marginBottom:12 }}>{t.description}</div>}
                  {can('esign.template_manage') && (
                    <div style={{ display:'flex', gap:6, flexWrap:'wrap' as const }}>
                      <button className="btn btn-ghost btn-sm" onClick={async () => {
                        const full = await apiGet<any>(`/esign/templates/${t.id}`)
                        setEditTemplate(full)
                      }}>
                        <Settings size={12} /> Edit Fields
                      </button>
                      {t.purpose !== 'work_trade_addendum' && t.unitType && !t.isUnitTypeDefault && (
                        <button className="btn btn-ghost btn-sm" disabled={setDefaultTemplateMut.isLoading} onClick={() => setDefaultTemplateMut.mutate(t.id)}>
                          Make default
                        </button>
                      )}
                      <button className="btn btn-ghost btn-sm" style={{ color:'var(--red)' }} onClick={() => {
                        appConfirm('Delete template "' + t.name + '"? This cannot be undone.', { danger: true, confirmLabel: 'Delete' }).then(ok => { if (ok) deleteTemplateMut.mutate(t.id) })
                      }}>
                        <Trash2 size={12} />
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* New template modal */}
      {showNewTemplate && (
        <div className="modal-overlay" onClick={() => setShowNewTemplate(false)}>
          <div className="modal" style={{ maxWidth:400 }} onClick={e => e.stopPropagation()}>
            <div className="modal-title">New Template</div>
            <div style={{ marginBottom:12 }}>
              <label style={{ fontSize:'.72rem', fontWeight:600, color:'var(--text-3)', textTransform:'uppercase' as const, letterSpacing:'.06em', display:'block', marginBottom:5 }}>Template Name *</label>
              <input className="input" placeholder="Standard 12-Month Lease" value={newTmplName} onChange={e => setNewTmplName(e.target.value)} style={{ width:'100%' }} autoFocus />
            </div>
            <div style={{ marginBottom:12 }}>
              <label style={{ fontSize:'.72rem', fontWeight:600, color:'var(--text-3)', textTransform:'uppercase' as const, letterSpacing:'.06em', display:'block', marginBottom:5 }}>Form Type</label>
              <select className="form-select" value={newTmplPurpose} onChange={e => setNewTmplPurpose(e.target.value)} style={{ width:'100%' }}>
                <option value="lease">Lease (original + renewals)</option>
                <option value="work_trade_addendum">Work-Trade Addendum</option>
              </select>
              <div style={{ fontSize:'.65rem', color:'var(--text-3)', marginTop:3 }}>
                {newTmplPurpose === 'work_trade_addendum'
                  ? 'Your own work-trade addendum form — attaches to a lease renewal when a work-trade tenant needs a fresh tenancy.'
                  : 'A normal lease form, used for original leases and renewals.'}
              </div>
            </div>
            <div style={{ marginBottom:12 }}>
              <label style={{ fontSize:'.72rem', fontWeight:600, color:'var(--text-3)', textTransform:'uppercase' as const, letterSpacing:'.06em', display:'block', marginBottom:5 }}>Unit Type</label>
              <select className="form-select" value={newTmplUnitType} onChange={e => setNewTmplUnitType(e.target.value)} style={{ width:'100%' }}>
                <option value="" disabled>Select unit type…</option>
                <option value="all">All unit types (universal)</option>
                <option value="apartment">Apartment</option>
                <option value="single_family">Single family</option>
                <option value="rv_spot">RV spot</option>
                <option value="mobile_home">Mobile home</option>
                <option value="storage">Storage</option>
                <option value="commercial">Commercial</option>
              </select>
              <div style={{ fontSize:'.65rem', color:'var(--text-3)', marginTop:3 }}>Drafting only offers this template for matching units — an RV lease is not an apartment lease.</div>
            </div>
            <div style={{ marginBottom:12 }}>
              <label style={{ fontSize:'.72rem', fontWeight:600, color:'var(--text-3)', textTransform:'uppercase' as const, letterSpacing:'.06em', display:'block', marginBottom:5 }}>Property Lock</label>
              <select className="form-select" value={newTmplPropertyId} onChange={e => setNewTmplPropertyId(e.target.value)} style={{ width:'100%' }}>
                <option value="">Any property (unlocked)</option>
                {(tmplProperties as any[]).map((pr:any) => <option key={pr.id} value={pr.id}>{pr.name}</option>)}
              </select>
              {detectedPropertyName && newTmplPropertyId ? (
                <div style={{ fontSize:'.65rem', color:'var(--green)', marginTop:3 }}>✓ Detected &quot;{detectedPropertyName}&quot; in the document&apos;s text — locked automatically (change above if wrong).</div>
              ) : (
                <div style={{ fontSize:'.65rem', color:'var(--text-3)', marginTop:3 }}>Lease forms name their property — locking prevents sending the wrong property&apos;s form.</div>
              )}
            </div>
            {newTmplPurpose === 'lease' && <>
            <div style={{ marginBottom:12 }}>
              <label style={{ fontSize:'.72rem', fontWeight:600, color:'var(--text-3)', textTransform:'uppercase' as const, letterSpacing:'.06em', display:'block', marginBottom:5 }}>Security Deposit</label>
              <select className="form-select" value={newTmplDepositMonths} onChange={e => setNewTmplDepositMonths(e.target.value)} style={{ width:'100%' }}>
                <option value="">No auto-deposit (fill on each lease)</option>
                <option value="1">1 month&apos;s rent</option>
                <option value="1.5">1½ months&apos; rent</option>
                <option value="2">2 months&apos; rent</option>
              </select>
              <div style={{ fontSize:'.65rem', color:'var(--text-3)', marginTop:3 }}>Match what this lease states. The deposit auto-fills as unit rent × this — so the charge always matches the signed lease.</div>
            </div>
            <div style={{ marginBottom:12 }}>
              <label style={{ fontSize:'.72rem', fontWeight:600, color:'var(--text-3)', textTransform:'uppercase' as const, letterSpacing:'.06em', display:'block', marginBottom:5 }}>Default Lease Term</label>
              <select className="form-select" value={newTmplTermMonths} onChange={e => setNewTmplTermMonths(e.target.value)} style={{ width:'100%' }}>
                <option value="">Month-to-month</option>
                <option value="6">6 months</option>
                <option value="12">12 months (1 year)</option>
                <option value="24">24 months (2 years)</option>
              </select>
              <div style={{ fontSize:'.65rem', color:'var(--text-3)', marginTop:3 }}>Auto-fills the lease dates when drafting off a unit (start today, end + this term). Storage/RV are usually month-to-month; apartments a year.</div>
            </div>
            </>}
<div style={{ marginBottom:16 }}>
              <label style={{ fontSize:'.72rem', fontWeight:600, color:'var(--text-3)', textTransform:'uppercase' as const, letterSpacing:'.06em', display:'block', marginBottom:5 }}>Base PDF URL (optional)</label>
              <div style={{ display:'flex', gap:8, alignItems:'center' }}>
                <label style={{ flex:1, padding:'9px 12px', border:'1px dashed var(--border-0)', borderRadius:8, cursor:'pointer', fontSize:'.78rem', color:'var(--text-3)', textAlign:'center' as const, background:'var(--bg-2)' }}>
                  {tmplUploading ? 'Uploading…' : tmplUploadedName || '📎 Choose PDF file…'}
                  <input type="file" accept=".pdf" style={{ display:'none' }} onChange={async e => {
                    const file = e.target.files?.[0]
                    if (!file) return
                    setTmplUploading(true)
                    try {
                      const formData = new FormData()
                      formData.append('file', file)
                      const token = localStorage.getItem('gam_token')
                      const res = await fetch(`${API_URL}/api/esign/upload`, {
                        method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: formData
                      })
                      const data = await res.json()
                      if (data.success) {
                        setNewTmplPdf(data.data.url); setTmplUploadedName(data.data.filename); setTmplPageCount(data.data.pageCount || 1)
                        // S535: PDF text named exactly one property → lock suggestion.
                        if (data.data.detectedProperty) {
                          setNewTmplPropertyId(data.data.detectedProperty.propertyId)
                          setDetectedPropertyName(data.data.detectedProperty.propertyName)
                        } else { setDetectedPropertyName(null) }
                      }
                    } catch(err) { toast.error('Upload failed') }
                    setTmplUploading(false)
                  }} />
                </label>
                {newTmplPdf && <button onClick={() => { setNewTmplPdf(''); setTmplUploadedName('') }} style={{ background:'none', border:'none', cursor:'pointer', color:'var(--red)', fontSize:'.8rem' }}>✕</button>}
              </div>
              <div style={{ fontSize:'.65rem', color: newTmplPdf ? 'var(--green)' : 'var(--amber)', marginTop:3 }}>{newTmplPdf ? '✓ PDF uploaded — ready to add fields' : '⚠️ PDF required before opening editor'}</div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={() => setShowNewTemplate(false)}>Cancel</button>
              <button className="btn btn-primary" disabled={!newTmplName || !newTmplPdf || !newTmplUnitType || createTemplateMut.isLoading} onClick={() => createTemplateMut.mutate()}>
                {createTemplateMut.isLoading ? <span className="spinner" /> : 'Create & Edit Fields'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showSend && <SendDocumentModal onClose={() => setShowSend(false)} />}
      {showStandalone && <StandaloneDocModal templates={templates} onClose={() => setShowStandalone(false)} onDone={() => { qc.invalidateQueries('esign-documents'); setShowStandalone(false) }} />}
    </div>
  )
}
