// @ts-nocheck
import { useState, useRef, useCallback, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { apiGet, apiPost, apiPatch, apiDelete, apiPut } from '../lib/api'
import { useAuth } from '../context/AuthContext'
import { Plus, X, FileText, Send, Settings, Eye, Trash2, ChevronRight, Check, AlertCircle, Download, MoreVertical } from 'lucide-react'

const FIELD_TYPES = [
  { type:'signature', label:'Signature',  icon:'✍️', color:'#c9a227', w:200, h:60 },
  { type:'initials',  label:'Initials',   icon:'🔡', color:'#4a9eff', w:80,  h:50 },
  { type:'date',      label:'Date',       icon:'📅', color:'#22c55e', w:140, h:40 },
  { type:'text',      label:'Text Field', icon:'📝', color:'#a78bfa', w:200, h:40 },
  { type:'checkbox',  label:'Checkbox',   icon:'☑️', color:'#f59e0b', w:30,  h:30 },
  { type:'radio_group',label:'Multiple Choice', icon:'🔘', color:'#ec4899', w:180, h:30 },
]

const SIGNER_ROLES = ['landlord','primary','co_tenant_1','co_tenant_2','witness']

// Keep in sync with lease_template_fields.lease_column CHECK constraint (21 values).
// Only the text/date subset is surfaced in the Field Properties dropdown today —
// signature/initial/date_signed bindings are implied by field type + signer role.
const DATA_LABELS: Record<string, Array<{value:string; label:string}>> = {
  text: [
    { value:'tenant_name',            label:'Tenant name' },
    { value:'tenant_email',           label:'Tenant email' },
    { value:'landlord_name',          label:'Landlord name' },
    { value:'rent_amount',            label:'Rent amount' },
    { value:'security_deposit',       label:'Security deposit' },
    { value:'rent_due_day',           label:'Rent due day' },
    { value:'late_fee_grace_days',    label:'Late fee grace days' },
    { value:'late_fee_amount',        label:'Late fee amount' },
    { value:'lease_type',             label:'Lease type' },
    { value:'auto_renew',             label:'Auto-renew (Yes/No)' },
    { value:'auto_renew_mode',        label:'Auto-renew mode' },
    { value:'notice_days_required',   label:'Notice days required' },
    { value:'expiration_notice_days', label:'Expiration notice days' },
    { value:'custom_text',            label:'Custom text (entered at send time)' },
  ],
  date: [
    { value:'start_date',  label:'Lease start date' },
    { value:'end_date',    label:'Lease end date' },
    { value:'date_signed', label:'Date signed' },
  ],
}
const ROLE_COLORS: Record<string,string> = {
  landlord:'#c9a227', primary:'#22c55e', co_tenant_1:'#4a9eff', co_tenant_2:'#a78bfa', witness:'#f59e0b'
}

// ── FIELD ITEM ON CANVAS ──────────────────────────────────────
function FieldItem({ field, selected, onSelect, onMove, onDelete, onResize, scale }: any) {
  const ft = FIELD_TYPES.find(f => f.type === field.fieldType) || FIELD_TYPES[0]
  const color = ROLE_COLORS[field.signerRole] || '#888'
  const dragRef = useRef<{startX:number;startY:number;fieldX:number;fieldY:number}|null>(null)

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

  return (
    <div style={{ position:'absolute', left: field.x * scale - 1, top: field.y * scale - 1 }} onMouseDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}>
      {/* Delete button — outside the draggable area */}
      {selected && (
        <div
          onMouseDown={e => { e.stopPropagation(); e.preventDefault() }}
          onClick={e => { e.stopPropagation(); onDelete(field.id) }}
          style={{ position:'absolute', top:-14, right:-14, width:22, height:22, borderRadius:'50%', background:'#ef4444', border:'2px solid white', cursor:'pointer', color:'white', display:'flex', alignItems:'center', justifyContent:'center', fontSize:12, fontWeight:900, zIndex:999, lineHeight:1, userSelect:'none', pointerEvents:'all' }}>
          ×
        </div>
      )}
      {/* Draggable field */}
      <div onMouseDown={onMouseDown} style={{
        position:'relative', width: field.width * scale, height: field.height * scale,
        border: `2px solid ${selected ? color : color + '99'}`,
        borderRadius: field.fieldType === 'checkbox' ? 4 : 6,
        background: `${color}18`,
        cursor:'move', userSelect:'none', boxSizing:'border-box' as const,
        display:'flex', alignItems:'center', justifyContent:'center', gap:4,
        overflow:'visible',
      }}>
        <span style={{ fontSize: Math.max(8, 11 * scale), flexShrink:0, pointerEvents:'none' }}>{ft.icon}</span>
        {field.width * scale > 50 && (
          <span style={{ color, fontWeight:700, whiteSpace:'nowrap' as const, overflow:'hidden', textOverflow:'ellipsis', fontSize: Math.max(7, 9 * scale), pointerEvents:'none' }}>
            {field.label || ft.label}
          </span>
        )}
        {selected && [
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
        // Load PDF.js from CDN
        if (!(window as any).pdfjsLib) {
          await new Promise<void>((resolve, reject) => {
            const script = document.createElement('script')
            script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js'
            script.onload = () => {
              ;(window as any).pdfjsLib.GlobalWorkerOptions.workerSrc =
                'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'
              resolve()
            }
            script.onerror = reject
            document.head.appendChild(script)
          })
        }
        const pdfjsLib = (window as any).pdfjsLib
        const loadingTask = pdfjsLib.getDocument(url)
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
  const [fields, setFields] = useState<any[]>(template.fields || [])
  const [selectedField, setSelectedField] = useState<string|null>(null)
  const [activeTool, setActiveTool] = useState<string|null>(null)
  const [activeRole, setActiveRole] = useState('primary')
  const [currentPage, setCurrentPage] = useState(1)
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
      leaseColumn: f.leaseColumn || null
    })) }),
    { onSuccess: () => { qc.invalidateQueries('esign-templates'); onClose() } }
  )

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
        <button className="btn btn-primary btn-sm" onClick={() => saveMut.mutate()} disabled={saveMut.isLoading}>
          {saveMut.isLoading ? <span className="spinner" /> : <><Check size={13} /> Save Fields</>}
        </button>
      </div>

      <div style={{ flex:1, display:'flex', overflow:'hidden' }}>
        {/* Left panel — tools */}
        <div style={{ width:220, background:'var(--bg-1)', borderRight:'1px solid var(--border-0)', padding:16, overflowY:'auto', flexShrink:0 }}>
          <div style={{ fontSize:'.68rem', fontWeight:700, color:'var(--text-3)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:8 }}>Signer Role</div>
          <div style={{ display:'flex', flexDirection:'column', gap:4, marginBottom:16 }}>
            {SIGNER_ROLES.map(role => (
              <div key={role} onClick={() => setActiveRole(role)} style={{ padding:'6px 10px', borderRadius:6, cursor:'pointer', border:`1px solid ${activeRole===role?ROLE_COLORS[role]:'var(--border-0)'}`, background:activeRole===role?`${ROLE_COLORS[role]}22`:'transparent', fontSize:'.75rem', fontWeight:activeRole===role?700:400, color:activeRole===role?ROLE_COLORS[role]:'var(--text-3)', textTransform:'capitalize' }}>
                {role.replace('_',' ')}
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

          {activeTool && (
            <div style={{ padding:'8px 10px', background:'rgba(201,162,39,.08)', border:'1px solid rgba(201,162,39,.2)', borderRadius:8, fontSize:'.72rem', color:'var(--gold)', lineHeight:1.5 }}>
              Click on the document to place a <b>{activeTool}</b> field for <b>{activeRole.replace('_',' ')}</b>.
            </div>
          )}

          {/* Selected field properties */}
          {sel && (
            <div style={{ marginTop:16, borderTop:'1px solid var(--border-0)', paddingTop:12 }}>
              <div style={{ fontSize:'.68rem', fontWeight:700, color:'var(--text-3)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:8 }}>Field Properties</div>
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
                  <div style={{ fontSize:'.62rem', color:'var(--text-3)', marginTop:2 }}>Auto-fills from lease data at send time</div>
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
                    if (newFields.length === 0) return alert('Already stamped to all pages')
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
                url={`${template.basePdfUrl.startsWith('http') ? '' : 'http://localhost:4000'}${template.basePdfUrl}`}
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
                  onSelect={setSelectedField} onMove={moveField}
                  onResize={resizeField}
                  onDelete={(id: string) => { setFields(prev => prev.filter(x => x.id !== id)); setSelectedField(null) }}
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
  const [tenantEmails, setTenantEmails] = useState([''])
  const [tenantNames, setTenantNames] = useState([{ firstName: '', lastName: '' }])
  const [searches, setSearches] = useState([''])
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [prefillValues, setPrefillValues] = useState<Record<string,string>>({})
  const { data: templates = [] } = useQuery('esign-templates', () => apiGet('/esign/templates'))
  // Full template (with fields) — only fetched once a template is picked.
  const { data: fullTemplate } = useQuery<any>(
    ['esign-template', templateId],
    () => apiGet(`/esign/templates/${templateId}`),
    { enabled: !!templateId }
  )
  // Fields bound to a lease_column are the ones the landlord fills at send time.
  // De-dupe by leaseColumn so the same column on multiple signer roles appears once.
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
  const selectedTemplate = templates.find(t => t.id === templateId)
  const setEmail = (i, val) => { setTenantEmails(prev => prev.map((e,j) => j===i?val:e)); setSearches(prev => prev.map((e,j) => j===i?val:e)) }
  const selectTenant = (i, tenant) => { setTenantEmails(prev => prev.map((e,j) => j===i?tenant.email:e)); setSearches(prev => prev.map((e,j) => j===i?tenant.email:e)) }
  const handleSend = async () => {
    if (!templateId) { setError('Please select a template'); return }
    if (!authUser) { setError('Not logged in'); return }
    const validEmails = tenantEmails.filter(e => e.trim())
    if (!validEmails.length) { setError('Please enter at least one tenant email'); return }
    // Pick unitId from first tenant (required by backend for original_lease to build lease)
    const firstTenant = existingTenants.find(t => t.email === validEmails[0].trim())
    setSending(true); setError('')
    try {
      // Phase 1: Provision (or reuse) a user account for each tenant and collect their userId.
      // Backend /tenants/invite creates users+tenants rows if missing, reuses if present, returns userId.
      const signers = []
      let order = 1
      for (let i = 0; i < validEmails.length; i++) {
        const email = validEmails[i].trim()
        const existing = existingTenants.find(t => t.email === email)
        const nameParts = existing
          ? { firstName: existing.name.split(' ')[0] || 'Tenant', lastName: existing.name.split(' ').slice(1).join(' ') || '' }
          : { firstName: (tenantNames[i]?.firstName || email.split('@')[0]), lastName: (tenantNames[i]?.lastName || '') }
        // Provision. Needs unitId per invite endpoint contract.
        const inviteRes: any = await apiPost('/tenants/invite', {
          email,
          firstName: nameParts.firstName,
          lastName: nameParts.lastName,
          phone: null,
          unitId: firstTenant?.unitId || null,
        })
        const userId = inviteRes.data.userId
        signers.push({
          role: order === 1 ? 'primary' : 'co_tenant_' + (order - 1),
          name: (nameParts.firstName + ' ' + nameParts.lastName).trim() || email,
          email,
          phone: null,
          orderIndex: order,
          userId,
          unitId: existing ? existing.unitId : (firstTenant?.unitId || null),
        })
        order++
      }
      // Landlord signer from AuthContext
      signers.push({
        role: 'landlord',
        name: (authUser.firstName + ' ' + authUser.lastName).trim(),
        email: authUser.email,
        phone: null,
        orderIndex: order,
        userId: authUser.id,
      })
      const unitId = firstTenant ? firstTenant.unitId : null
      const title = selectedTemplate ? selectedTemplate.name + (firstTenant ? ' — Unit ' + firstTenant.unit : '') : 'Lease Agreement'
      const res = await apiPost('/esign/documents', { templateId, unitId, title, signers, prefillValues })
      await apiPost('/esign/documents/' + res.data.id + '/send', {})
      qc.invalidateQueries('esign-documents')
      onClose()
    } catch(e: any) { setError(e.message || 'Failed to send') }
    setSending(false)
  }
  return (
    <div className='modal-overlay' onClick={onClose}>
      <div className='modal' style={{ maxWidth:440 }} onClick={e => e.stopPropagation()}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
          <div className='modal-title' style={{ marginBottom:0 }}>Send Document</div>
          <button className='btn btn-ghost btn-sm' onClick={onClose}><X size={14} /></button>
        </div>
        <div style={{ marginBottom:16 }}>
          <label style={{ fontSize:'.72rem', fontWeight:600, color:'var(--text-3)', textTransform:'uppercase', letterSpacing:'.06em', display:'block', marginBottom:6 }}>Template *</label>
          <select className='input' style={{ width:'100%' }} value={templateId} onChange={e => onTemplateChange(e.target.value)} autoFocus>
            <option value=''>Select a template…</option>
            {templates.map(t => <option key={t.id} value={t.id}>{t.name} ({t.fieldCount} fields)</option>)}
          </select>
        </div>
        <div style={{ marginBottom:16 }}>
          <label style={{ fontSize:'.72rem', fontWeight:600, color:'var(--text-3)', textTransform:'uppercase', letterSpacing:'.06em', display:'block', marginBottom:6 }}>Tenant Email(s) *</label>
          {tenantEmails.map((email, i) => {
            const filtered = searches[i] ? existingTenants.filter(t => t.email.includes(searches[i]) || t.name.toLowerCase().includes(searches[i].toLowerCase())) : []
            const matched = existingTenants.find(t => t.email === email)
            return (
              <div key={i} style={{ marginBottom:8, position:'relative' }}>
                <div style={{ display:'flex', gap:6 }}>
                  <input className='input' placeholder='tenant@email.com' value={searches[i]} onChange={e => setEmail(i, e.target.value)} style={{ flex:1, borderColor: matched ? 'var(--green)' : undefined }} />
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
          <button className='btn btn-ghost btn-sm' onClick={() => { setTenantEmails(prev => [...prev,'']); setSearches(prev => [...prev,'']) }}><Plus size={12} /> Add another tenant</button>
        </div>
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
        {templateId && tenantEmails.some(e => e.trim()) && (
          <div style={{ padding:'10px 14px', background:'var(--bg-2)', border:'1px solid var(--border-0)', borderRadius:10, marginBottom:16, fontSize:'.75rem', color:'var(--text-2)', lineHeight:1.8 }}>
            <div><strong>Template:</strong> {selectedTemplate && selectedTemplate.name}</div>
            <div><strong>Signing order:</strong> {tenantEmails.filter(e=>e).map((_,i) => i === 0 ? 'Primary tenant' : 'Co-tenant ' + i).join(' → ')} → Landlord</div>
            <div style={{ marginTop:6, fontSize:'.68rem', color:'var(--text-3)' }}>Each signer receives a signing request + portal invite email.</div>
          </div>
        )}
        {error && <div style={{ color:'var(--red)', fontSize:'.75rem', marginBottom:10 }}>{error}</div>}
        <div className='modal-footer'>
          <button className='btn btn-ghost' onClick={onClose}>Cancel</button>
          <button className='btn btn-primary' disabled={sending || !templateId || !tenantEmails.some(e=>e.trim())} onClick={handleSend}>{sending ? <span className='spinner' /> : <><Send size={14} /> Send for Signing</>}</button>
        </div>
      </div>
    </div>
  )
}

export function ESignPage() {
  const qc = useQueryClient()
  const [tab, setTab]           = useState<'documents'|'templates'>('documents')
  const [editTemplate, setEditTemplate] = useState<any>(null)
  const [showSend, setShowSend] = useState(false)
  const [showNewTemplate, setShowNewTemplate] = useState(false)
  const [newTmplName, setNewTmplName] = useState('')
  const [newTmplPdf, setNewTmplPdf] = useState('')
  const [tmplUploading, setTmplUploading] = useState(false)
  const [tmplUploadedName, setTmplUploadedName] = useState('')
  const [tmplPageCount, setTmplPageCount] = useState(1)

  const { data: templates = [], isLoading: tmplLoading } = useQuery<any[]>('esign-templates', () => apiGet('/esign/templates'))
  const { data: documents = [], isLoading: docLoading  } = useQuery<any[]>('esign-documents',  () => apiGet('/esign/documents'))

  const deleteTemplateMut = useMutation(
    (id: string) => apiDelete('/esign/templates/' + id),
    { onSuccess: () => qc.invalidateQueries('esign-templates') }
  )

  const createTemplateMut = useMutation(
    () => apiPost('/esign/templates', { name: newTmplName, pageCount: tmplPageCount, basePdfUrl: newTmplPdf||null }),
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

  if (editTemplate) return <TemplateEditor template={editTemplate} onClose={() => setEditTemplate(null)} />

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">E-Signatures</h1>
          <p className="page-subtitle">Send documents for electronic signature</p>
        </div>
        <div style={{ display:'flex', gap:8 }}>
          {tab === 'documents' && <button className="btn btn-primary" onClick={() => setShowSend(true)}><Send size={15} /> Send Document</button>}
          {tab === 'templates' && <button className="btn btn-primary" onClick={() => setShowNewTemplate(true)}><Plus size={15} /> New Template</button>}
        </div>
      </div>

      <div style={{ display:'flex', gap:8, marginBottom:20 }}>
        {[{id:'documents',label:'Documents'},{id:'templates',label:'Templates'}].map(t => (
          <button key={t.id} onClick={() => setTab(t.id as any)} className={`btn btn-sm ${tab===t.id?'btn-primary':'btn-ghost'}`}>{t.label}</button>
        ))}
      </div>

      {/* Documents */}
      {tab === 'documents' && (
        <div className="card" style={{ padding:0 }}>
          {docLoading ? <div style={{ padding:32, textAlign:'center', color:'var(--text-3)' }}>Loading…</div> :
           (documents as any[]).length === 0 ? (
            <div className="empty-state" style={{ padding:48 }}>
              <FileText size={40} />
              <h3>No documents yet</h3>
              <p>Send your first document for signature.</p>
              <button className="btn btn-primary" onClick={() => setShowSend(true)}><Send size={14} /> Send Document</button>
            </div>
          ) : (
            <table className="data-table">
              <thead><tr><th>Document</th><th>Unit</th><th>Status</th><th>Signers</th><th>Sent</th><th>Completed</th><th></th></tr></thead>
              <tbody>
                {(documents as any[]).map(d => (
                  <tr key={d.id}>
                    <td style={{ fontWeight:600, color:'var(--text-0)' }}>{d.title}</td>
                    <td style={{ fontSize:'.75rem' }}>{d.propertyName} · Unit {d.unitNumber}</td>
                    <td><span className={`badge ${STATUS_COLORS[d.status]||'badge-muted'}`}>{d.status.replace('_',' ')}</span></td>
                    <td style={{ fontSize:'.75rem' }}>{d.signedCount}/{d.signerCount} signed</td>
                    <td style={{ fontSize:'.72rem', color:'var(--text-3)' }}>{d.sentAt ? new Date(d.sentAt).toLocaleDateString() : '—'}</td>
                    <td style={{ fontSize:'.72rem', color: d.completedAt ? 'var(--green)' : 'var(--text-3)' }}>{d.completedAt ? new Date(d.completedAt).toLocaleDateString() : '—'}</td>
                    <td>
                      <div style={{ display:'flex', gap:6 }}>
                        {d.completedPdfUrl && <a href={d.completedPdfUrl} className="btn btn-ghost btn-sm"><Download size={12} /></a>}
                        {d.status !== 'completed' && d.status !== 'voided' && (
                          <button className="btn btn-ghost btn-sm" style={{ color:'var(--red)' }} onClick={() => { if(window.confirm('Void this document?')) voidMut.mutate(d.id) }}><X size={12} /></button>
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
          {tmplLoading ? <div style={{ padding:32, textAlign:'center', color:'var(--text-3)' }}>Loading…</div> :
          (templates as any[]).length === 0 ? (
            <div className="empty-state" style={{ padding:48 }}>
              <FileText size={40} />
              <h3>No templates yet</h3>
              <p>Create a template to define reusable signature fields.</p>
              <button className="btn btn-primary" onClick={() => setShowNewTemplate(true)}><Plus size={14} /> New Template</button>
            </div>
          ) : (
            <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(260px,1fr))', gap:12 }}>
              {(templates as any[]).map(t => (
                <div key={t.id} className="card" style={{ padding:'16px' }}>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:10 }}>
                    <div>
                      <div style={{ fontWeight:700, color:'var(--text-0)', marginBottom:2 }}>{t.name}</div>
                      <div style={{ fontSize:'.72rem', color:'var(--text-3)' }}>{t.fieldCount} fields · {t.pageCount} pages</div>
                    </div>
                    <FileText size={18} style={{ color:'var(--text-3)' }} />
                  </div>
                  {t.description && <div style={{ fontSize:'.75rem', color:'var(--text-3)', marginBottom:12 }}>{t.description}</div>}
                  <div style={{ display:'flex', gap:6 }}>
                    <button className="btn btn-ghost btn-sm" onClick={async () => {
                      const full = await apiGet<any>(`/esign/templates/${t.id}`)
                      setEditTemplate(full)
                    }}>
                      <Settings size={12} /> Edit Fields
                    </button>
                    <button className="btn btn-ghost btn-sm" style={{ color:'var(--red)' }} onClick={() => {
                      if (window.confirm('Delete template "' + t.name + '"? This cannot be undone.')) {
                        deleteTemplateMut.mutate(t.id)
                      }
                    }}>
                      <Trash2 size={12} />
                    </button>
                  </div>
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
                      const res = await fetch('http://localhost:4000/api/esign/upload', {
                        method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: formData
                      })
                      const data = await res.json()
                      if (data.success) { setNewTmplPdf(data.data.url); setTmplUploadedName(data.data.filename); setTmplPageCount(data.data.pageCount || 1) }
                    } catch(err) { alert('Upload failed') }
                    setTmplUploading(false)
                  }} />
                </label>
                {newTmplPdf && <button onClick={() => { setNewTmplPdf(''); setTmplUploadedName('') }} style={{ background:'none', border:'none', cursor:'pointer', color:'var(--red)', fontSize:'.8rem' }}>✕</button>}
              </div>
              <div style={{ fontSize:'.65rem', color: newTmplPdf ? 'var(--green)' : 'var(--amber)', marginTop:3 }}>{newTmplPdf ? '✓ PDF uploaded — ready to add fields' : '⚠️ PDF required before opening editor'}</div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={() => setShowNewTemplate(false)}>Cancel</button>
              <button className="btn btn-primary" disabled={!newTmplName || !newTmplPdf || createTemplateMut.isLoading} onClick={() => createTemplateMut.mutate()}>
                {createTemplateMut.isLoading ? <span className="spinner" /> : 'Create & Edit Fields'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showSend && <SendDocumentModal onClose={() => setShowSend(false)} />}
    </div>
  )
}
