import { useEffect, useState } from 'react'
import { apiGet, apiPost, apiPatch, apiDelete } from '../lib/api'
import { Modal } from '../components/Modal'
import {
  Plus, ChevronRight, ArrowLeft, Search, AlertTriangle, Archive,
  Pencil,
} from 'lucide-react'

interface Category {
  id: string
  name: string
  sortOrder: number
}

interface InventoryItem {
  id: string
  name: string
  sku: string | null
  description: string | null
  categoryId: string | null
  categoryName: string | null
  costPrice: string
  sellPrice: string
  taxRate: string
  stockQty: number
  stockMin: number
  stockMax: number
  isActive: boolean
  archivedAt: string | null
  createdAt: string
  updatedAt: string
}

interface Adjustment {
  id: string
  adjustmentType: 'received' | 'sold' | 'used' | 'shrinkage' | 'count' | 'manual'
  quantityDelta: number
  stockQtyAfter: number
  notes: string | null
  referenceType: string | null
  createdAt: string
}

interface ItemDetail extends InventoryItem {
  adjustments: Adjustment[]
}

const ADJ_LABEL: Record<Adjustment['adjustmentType'], { label: string; color: string }> = {
  received:  { label: 'Received',  color: 'var(--green, #22c55e)' },
  sold:      { label: 'Sold',      color: 'var(--text-2)' },
  used:      { label: 'Used',      color: 'var(--text-2)' },
  shrinkage: { label: 'Shrinkage', color: 'var(--amber)' },
  count:     { label: 'Count',     color: 'var(--gold)' },
  manual:    { label: 'Manual',    color: 'var(--text-2)' },
}

function fmtMoney(n: string | number | null | undefined): string {
  if (n == null) return '$0.00'
  return `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function fmtDate(s: string | null | undefined): string {
  if (!s) return '—'
  return new Date(s).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export function InventoryPage() {
  const [items, setItems] = useState<InventoryItem[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [search, setSearch] = useState('')
  const [lowStockOnly, setLowStockOnly] = useState(false)
  const [categoryFilter, setCategoryFilter] = useState<string>('')
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [showCategories, setShowCategories] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const reload = async () => {
    setErr(null)
    try {
      const params: string[] = []
      if (search.trim()) params.push(`q=${encodeURIComponent(search.trim())}`)
      if (lowStockOnly)  params.push('lowStock=true')
      if (categoryFilter) params.push(`categoryId=${categoryFilter}`)
      const qs = params.length ? `?${params.join('&')}` : ''
      const [list, cats] = await Promise.all([
        apiGet<InventoryItem[]>(`/business-inventory/items${qs}`),
        apiGet<Category[]>('/business-inventory/categories'),
      ])
      setItems(list)
      setCategories(cats)
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Failed to load inventory')
    } finally { setLoading(false) }
  }

  useEffect(() => { reload() }, [search, lowStockOnly, categoryFilter])

  if (selectedId) {
    return (
      <ItemDetailView
        id={selectedId}
        categories={categories}
        onBack={() => setSelectedId(null)}
        onChange={() => reload()}
      />
    )
  }

  const lowStockCount = items.filter(i => i.stockMin > 0 && i.stockQty <= i.stockMin).length

  return (
    <div>
      <div style={{
        display: 'flex', justifyContent: 'space-between',
        alignItems: 'baseline', marginBottom: 24,
      }}>
        <div>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 28, margin: 0 }}>
            Inventory
          </h1>
          <div style={{ color: 'var(--text-2)', fontSize: 14, marginTop: 4 }}>
            Stock tracking for retail products, parts, or supplies.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => setShowCategories(true)} style={ghostBtn}>
            Categories
          </button>
          <button onClick={() => setShowCreate(true)} style={primaryBtnStyle}>
            <Plus size={14} /> New item
          </button>
        </div>
      </div>

      {err && <div style={errStyle}>{err}</div>}

      {lowStockCount > 0 && !lowStockOnly && (
        <div style={{
          padding: 12, marginBottom: 16,
          background: 'rgba(245,158,11,.08)',
          border: '1px solid rgba(245,158,11,.4)',
          borderRadius: 8,
          fontSize: 13, color: 'var(--text-1)',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <span>
            <AlertTriangle size={14} style={{ color: 'var(--amber)', marginRight: 6, verticalAlign: 'middle' }} />
            {lowStockCount} item{lowStockCount === 1 ? '' : 's'} at or below reorder point.
          </span>
          <button onClick={() => setLowStockOnly(true)}
            style={{ ...ghostBtn, padding: '4px 10px', fontSize: 12 }}>
            Show low stock →
          </button>
        </div>
      )}

      <div style={{ display: 'flex', gap: 12, marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 200, maxWidth: 360 }}>
          <Search size={14} style={{
            position: 'absolute', left: 10, top: '50%',
            transform: 'translateY(-50%)', color: 'var(--text-3)',
          }} />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search name or SKU…"
            style={{ ...inputStyle, paddingLeft: 32, marginTop: 0 }}
          />
        </div>
        <select value={categoryFilter}
          onChange={e => setCategoryFilter(e.target.value)}
          style={{ ...inputStyle, marginTop: 0, maxWidth: 200 }}>
          <option value="">All categories</option>
          {categories.map(c => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--text-1)', cursor: 'pointer' }}>
          <input type="checkbox" checked={lowStockOnly}
            onChange={e => setLowStockOnly(e.target.checked)} />
          Low stock only
        </label>
      </div>

      {loading ? (
        <div style={{ color: 'var(--text-2)' }}>Loading…</div>
      ) : items.length === 0 ? (
        <div style={emptyStyle}>
          {search || lowStockOnly || categoryFilter
            ? 'No items match these filters.'
            : 'No inventory items yet. Add your first one to get started.'}
        </div>
      ) : (
        <table style={tableStyle}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border-1)' }}>
              <th style={thStyle}>Item</th>
              <th style={thStyle}>Category</th>
              <th style={thStyle}>SKU</th>
              <th style={thStyle}>Price</th>
              <th style={thStyle}>Stock</th>
              <th style={thStyle}></th>
            </tr>
          </thead>
          <tbody>
            {items.map(i => {
              const low = i.stockMin > 0 && i.stockQty <= i.stockMin
              return (
                <tr key={i.id}
                  onClick={() => setSelectedId(i.id)}
                  style={{ borderBottom: '1px solid var(--border-0)', cursor: 'pointer' }}>
                  <td style={tdStyle}>
                    <strong style={{ color: 'var(--text-0)' }}>{i.name}</strong>
                    {i.description && (
                      <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
                        {i.description.slice(0, 80)}{i.description.length > 80 ? '…' : ''}
                      </div>
                    )}
                  </td>
                  <td style={tdStyle}>{i.categoryName ?? <span style={{ color: 'var(--text-3)' }}>—</span>}</td>
                  <td style={{ ...tdStyle, fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                    {i.sku || <span style={{ color: 'var(--text-3)' }}>—</span>}
                  </td>
                  <td style={tdStyle}>{fmtMoney(i.sellPrice)}</td>
                  <td style={tdStyle}>
                    <span style={{
                      fontWeight: 600,
                      color: low ? 'var(--amber)' : 'var(--text-0)',
                    }}>{i.stockQty}</span>
                    {i.stockMin > 0 && (
                      <span style={{ fontSize: 11, color: 'var(--text-3)', marginLeft: 4 }}>
                        / min {i.stockMin}
                      </span>
                    )}
                    {low && (
                      <AlertTriangle size={11} style={{
                        color: 'var(--amber)', marginLeft: 6, verticalAlign: 'middle',
                      }} />
                    )}
                  </td>
                  <td style={tdStyle}><ChevronRight size={14} color="var(--text-3)" /></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}

      {showCreate && (
        <ItemFormModal mode="create"
          categories={categories}
          onClose={() => setShowCreate(false)}
          onSaved={() => { setShowCreate(false); reload() }} />
      )}
      {showCategories && (
        <CategoryManagerModal
          categories={categories}
          onClose={() => { setShowCategories(false); reload() }} />
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────
//  Item detail view
// ─────────────────────────────────────────────────────────────────

function ItemDetailView({
  id, categories, onBack, onChange,
}: {
  id: string
  categories: Category[]
  onBack: () => void
  onChange: () => void
}) {
  const [item, setItem] = useState<ItemDetail | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [showAdjust, setShowAdjust] = useState(false)
  const [showEdit, setShowEdit] = useState(false)
  const [archiving, setArchiving] = useState(false)

  const reload = async () => {
    try {
      const d = await apiGet<ItemDetail>(`/business-inventory/items/${id}`)
      setItem(d)
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Failed to load item')
    }
  }
  useEffect(() => { reload() }, [id])

  const onArchive = async () => {
    if (!window.confirm(`Archive "${item?.name}"? It won't appear in lists but stays on record.`)) return
    setArchiving(true)
    try {
      await apiPost(`/business-inventory/items/${id}/archive`)
      onChange()
      onBack()
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Archive failed')
    } finally { setArchiving(false) }
  }

  if (!item) {
    return (
      <div>
        <button onClick={onBack} style={ghostBtn}>
          <ArrowLeft size={14} /> Back
        </button>
        {err && <div style={errStyle}>{err}</div>}
        <div style={{ color: 'var(--text-2)', marginTop: 16 }}>Loading…</div>
      </div>
    )
  }

  const low = item.stockMin > 0 && item.stockQty <= item.stockMin
  const marginPct = Number(item.costPrice) > 0
    ? Math.round(((Number(item.sellPrice) - Number(item.costPrice)) / Number(item.sellPrice)) * 100)
    : null

  return (
    <div>
      <button onClick={onBack} style={ghostBtn}>
        <ArrowLeft size={14} /> Back to inventory
      </button>

      {err && <div style={{ ...errStyle, marginTop: 16 }}>{err}</div>}

      <div style={{
        marginTop: 16, padding: 24,
        background: 'var(--bg-1)', border: '1px solid var(--border-0)',
        borderRadius: 12,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: 20 }}>
          <div>
            <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 24, margin: 0 }}>
              {item.name}
            </h1>
            <div style={{ display: 'flex', gap: 12, color: 'var(--text-2)', fontSize: 13, marginTop: 6 }}>
              {item.categoryName && <span>{item.categoryName}</span>}
              {item.sku && (
                <span style={{ fontFamily: 'var(--font-mono)' }}>SKU: {item.sku}</span>
              )}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => setShowEdit(true)} style={ghostBtn}>
              <Pencil size={12} /> Edit
            </button>
            <button onClick={onArchive} disabled={archiving} style={ghostBtn}>
              <Archive size={12} /> Archive
            </button>
          </div>
        </div>

        {item.description && (
          <div style={{
            padding: 12, marginBottom: 16,
            background: 'var(--bg-2)', borderRadius: 8,
            fontSize: 13, color: 'var(--text-1)',
          }}>
            {item.description}
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 20 }}>
          <Metric label="Cost"   value={fmtMoney(item.costPrice)} />
          <Metric label="Price"  value={fmtMoney(item.sellPrice)} accent />
          <Metric label="Margin" value={marginPct != null ? `${marginPct}%` : '—'} />
          <Metric label="Tax"    value={`${(Number(item.taxRate) * 100).toFixed(2)}%`} />
        </div>

        <div style={{
          padding: 16,
          background: low ? 'rgba(245,158,11,.06)' : 'var(--bg-2)',
          border: `1px solid ${low ? 'rgba(245,158,11,.4)' : 'var(--border-0)'}`,
          borderRadius: 8,
          marginBottom: 20,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <div style={{ fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: 1 }}>
              Stock on hand
            </div>
            <button onClick={() => setShowAdjust(true)} style={primaryBtnStyle}>
              Adjust stock
            </button>
          </div>
          <div style={{
            fontSize: 32, fontWeight: 700,
            color: low ? 'var(--amber)' : 'var(--text-0)',
            display: 'flex', alignItems: 'baseline', gap: 12,
          }}>
            {item.stockQty}
            {low && (
              <span style={{ fontSize: 12, color: 'var(--amber)' }}>
                <AlertTriangle size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />
                At or below reorder point
              </span>
            )}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 4 }}>
            Min: {item.stockMin}{item.stockMax > 0 ? ` · Max: ${item.stockMax}` : ''}
          </div>
        </div>

        {/* Adjustment history */}
        <h2 style={{
          fontSize: 14, color: 'var(--text-2)',
          textTransform: 'uppercase' as const, letterSpacing: 1, margin: '0 0 8px 0',
        }}>Recent activity</h2>
        {item.adjustments.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--text-3)' }}>No activity yet.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {item.adjustments.map(adj => {
              const lbl = ADJ_LABEL[adj.adjustmentType]
              return (
                <div key={adj.id} style={{
                  display: 'flex', alignItems: 'center', gap: 12,
                  padding: '10px 14px',
                  background: 'var(--bg-2)', borderRadius: 8,
                }}>
                  <div style={{
                    minWidth: 90, fontSize: 11, fontWeight: 700,
                    color: lbl.color,
                    textTransform: 'uppercase' as const, letterSpacing: 0.5,
                  }}>{lbl.label}</div>
                  <div style={{
                    minWidth: 60, fontFamily: 'var(--font-mono)',
                    fontSize: 14, fontWeight: 600,
                    color: adj.quantityDelta > 0 ? 'var(--green, #22c55e)'
                          : adj.quantityDelta < 0 ? 'var(--red, #ef4444)'
                          : 'var(--text-2)',
                  }}>
                    {adj.quantityDelta > 0 ? '+' : ''}{adj.quantityDelta}
                  </div>
                  <div style={{ flex: 1, fontSize: 13, color: 'var(--text-1)' }}>
                    {adj.notes || <span style={{ color: 'var(--text-3)' }}>—</span>}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>
                    → {adj.stockQtyAfter}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
                    {fmtDate(adj.createdAt)}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {showAdjust && (
        <AdjustStockModal
          item={item}
          onClose={() => setShowAdjust(false)}
          onSaved={() => { setShowAdjust(false); reload(); onChange() }} />
      )}
      {showEdit && (
        <ItemFormModal mode="edit"
          item={item}
          categories={categories}
          onClose={() => setShowEdit(false)}
          onSaved={() => { setShowEdit(false); reload(); onChange() }} />
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────
//  Item form modal (create + edit)
// ─────────────────────────────────────────────────────────────────

function ItemFormModal({
  mode, item, categories, onClose, onSaved,
}: {
  mode: 'create' | 'edit'
  item?: InventoryItem
  categories: Category[]
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState({
    name:        item?.name        ?? '',
    sku:         item?.sku         ?? '',
    description: item?.description ?? '',
    categoryId:  item?.categoryId  ?? '',
    costPrice:   item ? String(item.costPrice) : '0',
    sellPrice:   item ? String(item.sellPrice) : '0',
    taxRate:     item ? String((Number(item.taxRate) * 100).toFixed(2)) : '0',
    stockQty:    item ? String(item.stockQty) : '0',
    stockMin:    item ? String(item.stockMin) : '0',
    stockMax:    item ? String(item.stockMax) : '0',
  })
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = async () => {
    setErr(null)
    if (!form.name.trim()) { setErr('Name is required'); return }
    setSaving(true)
    try {
      const payload: any = {
        name:        form.name.trim(),
        sku:         form.sku.trim() || null,
        description: form.description.trim() || null,
        categoryId:  form.categoryId || null,
        costPrice:   Number(form.costPrice) || 0,
        sellPrice:   Number(form.sellPrice) || 0,
        taxRate:     (Number(form.taxRate) || 0) / 100,
        stockMin:    parseInt(form.stockMin, 10) || 0,
        stockMax:    parseInt(form.stockMax, 10) || 0,
      }
      if (mode === 'create') {
        payload.stockQty = parseInt(form.stockQty, 10) || 0
        await apiPost('/business-inventory/items', payload)
      } else {
        await apiPatch(`/business-inventory/items/${item!.id}`, payload)
      }
      onSaved()
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Save failed')
    } finally { setSaving(false) }
  }

  return (
    <Modal title={mode === 'create' ? 'New inventory item' : 'Edit item'}
      onClose={onClose}
      width={560}
      footer={
        <>
          <button onClick={onClose} style={ghostBtn}>Cancel</button>
          <button onClick={submit} disabled={saving} style={primaryBtnStyle}>
            {saving ? 'Saving…' : mode === 'create' ? 'Create item' : 'Save changes'}
          </button>
        </>
      }>
      {err && <div style={errStyle}>{err}</div>}

      <label style={labelStyle}>Name</label>
      <input value={form.name}
        onChange={e => setForm({ ...form, name: e.target.value })}
        placeholder="Widget / Oil filter / etc."
        style={inputStyle} />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div>
          <label style={labelStyle}>SKU / Barcode (optional)</label>
          <input value={form.sku}
            onChange={e => setForm({ ...form, sku: e.target.value })}
            style={{ ...inputStyle, fontFamily: 'var(--font-mono)' as const }} />
        </div>
        <div>
          <label style={labelStyle}>Category</label>
          <select value={form.categoryId}
            onChange={e => setForm({ ...form, categoryId: e.target.value })}
            style={inputStyle}>
            <option value="">— None —</option>
            {categories.map(c => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
      </div>

      <label style={labelStyle}>Description (optional)</label>
      <textarea value={form.description}
        onChange={e => setForm({ ...form, description: e.target.value })}
        rows={2}
        style={{ ...inputStyle, fontFamily: 'var(--font-body)' as const, resize: 'vertical' as const }} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
        <div>
          <label style={labelStyle}>Cost</label>
          <input type="number" step="0.01" min="0"
            value={form.costPrice}
            onChange={e => setForm({ ...form, costPrice: e.target.value })}
            style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>Sell price</label>
          <input type="number" step="0.01" min="0"
            value={form.sellPrice}
            onChange={e => setForm({ ...form, sellPrice: e.target.value })}
            style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>Tax %</label>
          <input type="number" step="0.01" min="0" max="99.99"
            value={form.taxRate}
            onChange={e => setForm({ ...form, taxRate: e.target.value })}
            style={inputStyle} />
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: mode === 'create' ? 'repeat(3, 1fr)' : 'repeat(2, 1fr)', gap: 12 }}>
        {mode === 'create' && (
          <div>
            <label style={labelStyle}>Starting stock</label>
            <input type="number" min="0"
              value={form.stockQty}
              onChange={e => setForm({ ...form, stockQty: e.target.value })}
              style={inputStyle} />
          </div>
        )}
        <div>
          <label style={labelStyle}>Reorder point</label>
          <input type="number" min="0"
            value={form.stockMin}
            onChange={e => setForm({ ...form, stockMin: e.target.value })}
            style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>Target on hand</label>
          <input type="number" min="0"
            value={form.stockMax}
            onChange={e => setForm({ ...form, stockMax: e.target.value })}
            style={inputStyle} />
        </div>
      </div>
    </Modal>
  )
}

// ─────────────────────────────────────────────────────────────────
//  Stock adjustment modal
// ─────────────────────────────────────────────────────────────────

function AdjustStockModal({
  item, onClose, onSaved,
}: {
  item: InventoryItem
  onClose: () => void
  onSaved: () => void
}) {
  const [type, setType] = useState<Adjustment['adjustmentType']>('received')
  const [delta, setDelta] = useState('')
  const [resultingQty, setResultingQty] = useState(String(item.stockQty))
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const isCount = type === 'count'

  // Most adjustment types reduce stock; received increases it.
  const sign: 1 | -1 = (type === 'received') ? 1 : -1
  const preview = isCount
    ? (parseInt(resultingQty, 10) || 0) - item.stockQty
    : sign * (parseInt(delta, 10) || 0)
  const willResult = isCount
    ? (parseInt(resultingQty, 10) || 0)
    : item.stockQty + preview

  const submit = async () => {
    setErr(null)
    if (isCount) {
      if (!resultingQty || isNaN(Number(resultingQty))) {
        setErr('Enter the counted quantity'); return
      }
    } else {
      if (!delta || isNaN(Number(delta)) || Number(delta) <= 0) {
        setErr('Enter a quantity greater than 0'); return
      }
      if (willResult < 0) {
        setErr(`Not enough stock (current ${item.stockQty})`); return
      }
    }
    setSaving(true)
    try {
      await apiPost(`/business-inventory/items/${item.id}/adjust`, {
        adjustmentType: type,
        ...(isCount
          ? { resultingQty: parseInt(resultingQty, 10) || 0 }
          : { quantityDelta: sign * (parseInt(delta, 10) || 0) }),
        notes: notes.trim() || null,
      })
      onSaved()
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Adjustment failed')
    } finally { setSaving(false) }
  }

  return (
    <Modal title={`Adjust stock — ${item.name}`} onClose={onClose}
      footer={
        <>
          <button onClick={onClose} style={ghostBtn}>Cancel</button>
          <button onClick={submit} disabled={saving} style={primaryBtnStyle}>
            {saving ? 'Saving…' : 'Apply adjustment'}
          </button>
        </>
      }>
      {err && <div style={errStyle}>{err}</div>}

      <div style={{
        padding: 12, marginBottom: 12,
        background: 'var(--bg-2)', borderRadius: 8,
        fontSize: 13, color: 'var(--text-2)',
        display: 'flex', justifyContent: 'space-between',
      }}>
        <span>Current stock</span>
        <strong style={{ color: 'var(--text-0)', fontFamily: 'var(--font-mono)' as const }}>
          {item.stockQty}
        </strong>
      </div>

      <label style={labelStyle}>Reason</label>
      <select value={type}
        onChange={e => setType(e.target.value as any)}
        style={inputStyle}>
        <option value="received">Received (stock in)</option>
        <option value="sold">Sold (stock out)</option>
        <option value="used">Used on a job</option>
        <option value="shrinkage">Shrinkage / damage</option>
        <option value="count">Physical count (set exact number)</option>
        <option value="manual">Manual correction</option>
      </select>

      {isCount ? (
        <>
          <label style={labelStyle}>Counted quantity</label>
          <input type="number" min="0"
            value={resultingQty}
            onChange={e => setResultingQty(e.target.value)}
            style={{ ...inputStyle, fontSize: 18 }} />
        </>
      ) : (
        <>
          <label style={labelStyle}>Quantity</label>
          <input type="number" min="1"
            value={delta}
            onChange={e => setDelta(e.target.value)}
            style={{ ...inputStyle, fontSize: 18 }} />
        </>
      )}

      <label style={labelStyle}>Notes (optional)</label>
      <input value={notes}
        onChange={e => setNotes(e.target.value)}
        placeholder="PO #123 / shipment from Acme / etc."
        style={inputStyle} />

      <div style={{
        marginTop: 16, padding: 12,
        background: 'var(--bg-2)', borderRadius: 8,
        display: 'flex', justifyContent: 'space-between' as const,
        fontSize: 13,
      }}>
        <span style={{ color: 'var(--text-2)' }}>After this adjustment</span>
        <strong style={{
          color: 'var(--gold)',
          fontFamily: 'var(--font-mono)' as const,
        }}>
          {willResult}
        </strong>
      </div>
    </Modal>
  )
}

// ─────────────────────────────────────────────────────────────────
//  Category manager modal
// ─────────────────────────────────────────────────────────────────

function CategoryManagerModal({
  categories, onClose,
}: {
  categories: Category[]
  onClose: () => void
}) {
  const [cats, setCats] = useState<Category[]>(categories)
  const [newName, setNewName] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const reload = async () => {
    const fresh = await apiGet<Category[]>('/business-inventory/categories')
    setCats(fresh)
  }

  const onAdd = async () => {
    if (!newName.trim()) return
    setBusy(true); setErr(null)
    try {
      await apiPost('/business-inventory/categories', { name: newName.trim() })
      setNewName('')
      await reload()
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Create failed')
    } finally { setBusy(false) }
  }

  const onDelete = async (c: Category) => {
    if (!window.confirm(`Delete category "${c.name}"? Items in it stay but become uncategorized.`)) return
    setBusy(true); setErr(null)
    try {
      await apiDelete(`/business-inventory/categories/${c.id}`)
      await reload()
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Delete failed')
    } finally { setBusy(false) }
  }

  return (
    <Modal title="Inventory categories" onClose={onClose}
      footer={<button onClick={onClose} style={primaryBtnStyle}>Done</button>}>
      {err && <div style={errStyle}>{err}</div>}

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <input value={newName}
          onChange={e => setNewName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') onAdd() }}
          placeholder="New category name"
          style={{ ...inputStyle, marginTop: 0 }} />
        <button onClick={onAdd} disabled={busy || !newName.trim()}
          style={primaryBtnStyle}>
          <Plus size={14} /> Add
        </button>
      </div>

      {cats.length === 0 ? (
        <div style={{ ...emptyStyle, marginBottom: 0 }}>No categories yet.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {cats.map(c => (
            <div key={c.id} style={{
              display: 'flex' as const, alignItems: 'center',
              justifyContent: 'space-between',
              padding: '10px 14px',
              background: 'var(--bg-2)', borderRadius: 8,
              fontSize: 14, color: 'var(--text-0)',
            }}>
              <span>{c.name}</span>
              <button onClick={() => onDelete(c)} disabled={busy}
                style={{
                  background: 'transparent', border: 'none',
                  color: 'var(--text-3)', cursor: 'pointer',
                  fontSize: 12,
                }}>
                Delete
              </button>
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}

// ─────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────

function Metric({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <div style={{
        fontSize: 11, color: 'var(--text-3)',
        textTransform: 'uppercase' as const, letterSpacing: 1,
        marginBottom: 4,
      }}>{label}</div>
      <div style={{
        fontSize: 18, fontWeight: 700,
        color: accent ? 'var(--gold)' : 'var(--text-0)',
        fontFamily: 'var(--font-mono)' as const,
      }}>{value}</div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────
//  Styles
// ─────────────────────────────────────────────────────────────────

const tableStyle: React.CSSProperties = {
  width: '100%', borderCollapse: 'collapse' as const,
  background: 'var(--bg-1)', border: '1px solid var(--border-0)',
  borderRadius: 12, overflow: 'hidden' as const,
}
const thStyle: React.CSSProperties = {
  textAlign: 'left' as const, padding: '12px 16px',
  fontSize: 12, color: 'var(--text-2)',
  textTransform: 'uppercase' as const,
  letterSpacing: 1, background: 'var(--bg-2)',
  fontWeight: 600,
}
const tdStyle: React.CSSProperties = {
  padding: '14px 16px', fontSize: 14, color: 'var(--text-1)',
}
const labelStyle: React.CSSProperties = {
  display: 'block' as const, fontSize: 12, color: 'var(--text-2)',
  marginBottom: 6, marginTop: 12,
}
const inputStyle: React.CSSProperties = {
  width: '100%', padding: '10px 12px',
  background: 'var(--bg-2)', color: 'var(--text-0)',
  border: '1px solid var(--border-1)', borderRadius: 8,
  fontSize: 14, boxSizing: 'border-box' as const,
}
const primaryBtnStyle: React.CSSProperties = {
  padding: '8px 14px',
  background: 'var(--gold)', color: 'var(--bg-0)',
  border: 'none', borderRadius: 8,
  fontSize: 13, fontWeight: 600,
  cursor: 'pointer',
  display: 'inline-flex' as const, alignItems: 'center', gap: 6,
}
const ghostBtn: React.CSSProperties = {
  padding: '8px 14px', background: 'transparent', color: 'var(--text-1)',
  border: '1px solid var(--border-1)', borderRadius: 8,
  fontSize: 13, fontWeight: 500, cursor: 'pointer',
  display: 'inline-flex' as const, alignItems: 'center', gap: 6,
}
const errStyle: React.CSSProperties = {
  marginBottom: 12, padding: '10px 12px',
  background: 'var(--red-bg)', color: 'var(--red, #ef4444)',
  border: '1px solid var(--red-dim, #ef4444)', borderRadius: 8, fontSize: 13,
}
const emptyStyle: React.CSSProperties = {
  padding: 32, textAlign: 'center' as const,
  background: 'var(--bg-1)', border: '1px solid var(--border-0)',
  borderRadius: 12, color: 'var(--text-2)', fontSize: 14,
  marginBottom: 16,
}
