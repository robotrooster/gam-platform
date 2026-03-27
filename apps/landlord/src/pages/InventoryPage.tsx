import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { useSearchParams } from 'react-router-dom'
import { apiGet, apiPost, apiPatch, apiDelete } from '../lib/api'
import { formatCurrency } from '@gam/shared'
import {
  Package, Plus, Edit2, X, Check, AlertTriangle, TrendingUp,
  Truck, ShoppingBag, BarChart2, DollarSign, RefreshCw, QrCode, Trash2
} from 'lucide-react'

const CATS = ['all','fuel','amenity','laundry','parking','fee','misc']

function ItemModal({ item, vendors, categories, onClose }: { item?: any; vendors: any[]; categories?: any[]; onClose: () => void }) {
  const qc = useQueryClient()
  const isEdit = !!item
  const [form, setForm] = useState({
    name:        item?.name || '',
    category:    item?.category || 'misc',
    icon:        item?.icon || '📦',
    costPrice:   item?.cost_price || '',
    sellPrice:   item?.sell_price || '',
    marginPct:   item?.margin_pct || '',
    taxRate:     item?.tax_rate ? (item.tax_rate * 100).toFixed(0) : '0',
    chargeEligible: item?.charge_eligible ?? true,
    stockQty:    item?.stock_qty || '0',
    stockMin:    item?.stock_min || '5',
    stockMax:    item?.stock_max || '50',
    vendorId:    item?.vendor_id || '',
  })

  const set = (k: string, v: any) => {
    setForm(f => {
      const next = { ...f, [k]: v }
      // Auto-calculate sell price from cost + margin
      if ((k === 'costPrice' || k === 'marginPct') && next.costPrice && next.marginPct) {
        const cost = parseFloat(next.costPrice)
        const margin = parseFloat(next.marginPct) / 100
        if (!isNaN(cost) && !isNaN(margin) && margin < 1) {
          next.sellPrice = (cost / (1 - margin)).toFixed(2)
        }
      }
      // Auto-calculate margin from cost + sell
      if ((k === 'costPrice' || k === 'sellPrice') && next.costPrice && next.sellPrice) {
        const cost = parseFloat(next.costPrice)
        const sell = parseFloat(next.sellPrice)
        if (!isNaN(cost) && !isNaN(sell) && sell > 0) {
          next.marginPct = (((sell - cost) / sell) * 100).toFixed(1)
        }
      }
      return next
    })
  }

  const mut = useMutation(
    (data: any) => isEdit ? apiPatch(`/pos/items/${item.id}`, data) : apiPost('/pos/items', data),
    { onSuccess: () => { qc.invalidateQueries('pos-items'); onClose() } }
  )

  const save = () => mut.mutate({
    name: form.name, category: form.category, icon: form.icon,
    costPrice: parseFloat(form.costPrice) || 0,
    sellPrice: parseFloat(form.sellPrice),
    marginPct: parseFloat(form.marginPct) || null,
    taxRate: parseFloat(form.taxRate) / 100,
    chargeEligible: form.chargeEligible,
    stockQty: parseInt(form.stockQty),
    stockMin: parseInt(form.stockMin),
    stockMax: parseInt(form.stockMax),
    vendorId: form.vendorId || null,
  })

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 540, maxHeight: '90vh', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <div className="modal-title" style={{ marginBottom: 0 }}>{isEdit ? 'Edit Item' : 'Add Item'}</div>
          <button className="btn btn-ghost btn-sm" onClick={onClose} style={{ padding: 6 }}><X size={15} /></button>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase' as const, letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>Item Name *</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input className="input" value={form.icon} onChange={e => set('icon', e.target.value)} style={{ width: 52, textAlign: 'center', fontSize: '1.3rem', flexShrink: 0 }} title="Icon (emoji)" />
            <input className="input" placeholder="e.g. Propane 20lb" value={form.name} onChange={e => set('name', e.target.value)} style={{ flex: 1 }} autoFocus />
          </div>
          <div style={{ fontSize: '.65rem', color: 'var(--text-3)', marginTop: 3 }}>Emoji icon on left, item name on right</div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
          <div>
            <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase' as const, letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>Category</label>
<div style={{ display:'flex', gap:6 }}>
              <select className="input" style={{ flex:1 }} value={form.category} onChange={e => set('category', e.target.value)}>
                {(categories && categories.length > 0 ? categories : [{name:'fuel'},{name:'amenity'},{name:'laundry'},{name:'parking'},{name:'fee'},{name:'misc'}]).map((cat: any) => <option key={cat.name || cat} value={(cat.name || cat).toLowerCase()}>{cat.name || cat}</option>)}
              </select>
              <button type="button" className="btn btn-ghost btn-sm" title="Add new category" onClick={async () => {
                const name = window.prompt('New category name:')
                if (name) {
                  const icon = window.prompt('Icon (emoji):', '📦') || '📦'
                  await fetch('/api/pos/categories', { method:'POST', headers:{'Content-Type':'application/json', Authorization: 'Bearer ' + localStorage.getItem('gam_token')}, body: JSON.stringify({ name, icon }) })
                  window.location.reload()
                }
              }} style={{ flexShrink:0 }}><Plus size={13} /></button>
            </div>
          </div>
          <div>
            <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase' as const, letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>Vendor</label>
            <select className="input" style={{ width: '100%' }} value={form.vendorId} onChange={e => set('vendorId', e.target.value)}>
              <option value="">No vendor</option>
              {vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          </div>
        </div>

        {/* Pricing */}
        <div style={{ background: 'var(--bg-2)', border: '1px solid var(--border-0)', borderRadius: 10, padding: 14, marginBottom: 12 }}>
          <div style={{ fontSize: '.68rem', fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase' as const, letterSpacing: '.08em', marginBottom: 10 }}>Pricing — Set any two, third auto-calculates</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
            <div>
              <label style={{ fontSize: '.68rem', color: 'var(--text-3)', display: 'block', marginBottom: 4 }}>Cost Price</label>
              <div style={{ position: 'relative' }}>
                <span style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-3)', fontSize: '.78rem' }}>$</span>
                <input className="input" type="number" step="0.01" placeholder="0.00" value={form.costPrice} onChange={e => set('costPrice', e.target.value)} style={{ paddingLeft: 20, width: '100%' }} />
              </div>
            </div>
            <div>
              <label style={{ fontSize: '.68rem', color: 'var(--text-3)', display: 'block', marginBottom: 4 }}>Margin %</label>
              <div style={{ position: 'relative' }}>
                <input className="input" type="number" step="0.1" placeholder="0.0" value={form.marginPct} onChange={e => set('marginPct', e.target.value)} style={{ paddingRight: 20, width: '100%' }} />
                <span style={{ position: 'absolute', right: 9, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-3)', fontSize: '.78rem' }}>%</span>
              </div>
            </div>
            <div>
              <label style={{ fontSize: '.68rem', color: 'var(--gold)', display: 'block', marginBottom: 4 }}>Sell Price *</label>
              <div style={{ position: 'relative' }}>
                <span style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: 'var(--gold)', fontSize: '.78rem' }}>$</span>
                <input className="input" type="number" step="0.01" placeholder="0.00" value={form.sellPrice} onChange={e => set('sellPrice', e.target.value)} style={{ paddingLeft: 20, width: '100%', borderColor: 'rgba(201,162,39,.3)' }} />
              </div>
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 }}>
            <div>
              <label style={{ fontSize: '.68rem', color: 'var(--text-3)', display: 'block', marginBottom: 4 }}>Tax Rate</label>
              <div style={{ position: 'relative' }}>
                <input className="input" type="number" step="0.5" placeholder="0" value={form.taxRate} onChange={e => set('taxRate', e.target.value)} style={{ paddingRight: 20, width: '100%' }} />
                <span style={{ position: 'absolute', right: 9, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-3)', fontSize: '.78rem' }}>%</span>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 20 }}>
              <input type="checkbox" checked={form.chargeEligible} onChange={e => set('chargeEligible', e.target.checked)} id="charge-eligible" />
              <label htmlFor="charge-eligible" style={{ fontSize: '.78rem', color: 'var(--text-2)', cursor: 'pointer' }}>⚡ Charge account eligible</label>
            </div>
          </div>
        </div>

        {/* Inventory */}
        <div style={{ background: 'var(--bg-2)', border: '1px solid var(--border-0)', borderRadius: 10, padding: 14, marginBottom: 16 }}>
          <div style={{ fontSize: '.68rem', fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase' as const, letterSpacing: '.08em', marginBottom: 10 }}>
            Inventory — Use 999 for unlimited/service items
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
            {[
              { label: 'Current Stock', key: 'stockQty' },
              { label: 'Min (Reorder Point)', key: 'stockMin' },
              { label: 'Max (Par Level)', key: 'stockMax' },
            ].map(f => (
              <div key={f.key}>
                <label style={{ fontSize: '.68rem', color: 'var(--text-3)', display: 'block', marginBottom: 4 }}>{f.label}</label>
                <input className="input" type="number" value={(form as any)[f.key]} onChange={e => set(f.key, e.target.value)} style={{ width: '100%' }} />
              </div>
            ))}
          </div>
        </div>

        {mut.isError && <div style={{ color: 'var(--red)', fontSize: '.75rem', marginBottom: 10 }}>Failed to save item.</div>}

        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!form.name || !form.sellPrice || mut.isLoading} onClick={save}>
            {mut.isLoading ? <span className="spinner" /> : <><Check size={14} /> {isEdit ? 'Save Changes' : 'Add Item'}</>}
          </button>
        </div>
      </div>
    </div>
  )
}

function VendorModal({ vendor, onClose }: { vendor?: any; onClose: () => void }) {
  const qc = useQueryClient()
  const isEdit = !!vendor
  const [form, setForm] = useState({
    name: vendor?.name || '', contactName: vendor?.contact_name || '',
    email: vendor?.email || '', phone: vendor?.phone || '',
    address: vendor?.address || '', leadTimeDays: vendor?.lead_time_days || '3', notes: vendor?.notes || '',
  })
  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }))
  const mut = useMutation(
    (data: any) => isEdit ? apiPatch(`/pos/vendors/${vendor.id}`, data) : apiPost('/pos/vendors', data),
    { onSuccess: () => { qc.invalidateQueries('pos-vendors'); onClose() } }
  )
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 460 }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <div className="modal-title" style={{ marginBottom: 0 }}>{isEdit ? 'Edit Vendor' : 'Add Vendor'}</div>
          <button className="btn btn-ghost btn-sm" onClick={onClose} style={{ padding: 6 }}><X size={15} /></button>
        </div>
        {[
          { label: 'Vendor Name *', key: 'name', placeholder: 'e.g. AmeriGas' },
          { label: 'Contact Name', key: 'contactName', placeholder: 'John Smith' },
          { label: 'Email', key: 'email', placeholder: 'orders@vendor.com' },
          { label: 'Phone', key: 'phone', placeholder: '(555) 000-0000' },
          { label: 'Address', key: 'address', placeholder: '123 Main St, Phoenix AZ' },
        ].map(f => (
          <div key={f.key} style={{ marginBottom: 10 }}>
            <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase' as const, letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>{f.label}</label>
            <input className="input" placeholder={f.placeholder} value={(form as any)[f.key]} onChange={e => set(f.key, e.target.value)} style={{ width: '100%' }} />
          </div>
        ))}
        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase' as const, letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>Lead Time (days)</label>
          <input className="input" type="number" value={form.leadTimeDays} onChange={e => set('leadTimeDays', e.target.value)} style={{ width: 80 }} />
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!form.name || mut.isLoading} onClick={() => mut.mutate(form)}>
            {mut.isLoading ? <span className="spinner" /> : <><Check size={14} /> {isEdit ? 'Save' : 'Add Vendor'}</>}
          </button>
        </div>
      </div>
    </div>
  )
}

function StockAdjustModal({ item, onClose }: { item: any; onClose: () => void }) {
  const qc = useQueryClient()
  const [qty, setQty] = useState('')
  const [reason, setReason] = useState('restock')
  const [notes, setNotes] = useState('')
  const mut = useMutation(
    () => apiPost(`/pos/items/${item.id}/adjust-stock`, { changeQty: parseInt(qty), reason, notes }),
    { onSuccess: () => { qc.invalidateQueries('pos-items'); onClose() } }
  )
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 380 }} onClick={e => e.stopPropagation()}>
        <div className="modal-title">Adjust Stock — {item.name}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, padding: '10px 12px', background: 'var(--bg-2)', border: '1px solid var(--border-0)', borderRadius: 8 }}>
          <span style={{ fontSize: '1.4rem' }}>{item.icon}</span>
          <div>
            <div style={{ fontSize: '.82rem', fontWeight: 600 }}>{item.name}</div>
            <div style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>Current stock: <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-0)' }}>{item.stock_qty}</span></div>
          </div>
        </div>
        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase' as const, letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>Change Quantity (+ to add, - to remove)</label>
          <input className="input" type="number" placeholder="+10 or -3" value={qty} onChange={e => setQty(e.target.value)} style={{ width: '100%' }} autoFocus />
          {qty && <div style={{ fontSize: '.7rem', color: 'var(--gold)', marginTop: 3 }}>New stock: {item.stock_qty + parseInt(qty || '0')}</div>}
        </div>
        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase' as const, letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>Reason</label>
          <select className="input" style={{ width: '100%' }} value={reason} onChange={e => setReason(e.target.value)}>
            <option value="restock">Restock</option>
            <option value="adjustment">Adjustment / Count</option>
            <option value="damage">Damage / Loss</option>
            <option value="return">Customer Return</option>
            <option value="damage">Damage / Loss</option>
            <option value="expired">Expired</option>
          </select>
        </div>
        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase' as const, letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>Notes (optional)</label>
          <input className="input" placeholder="e.g. Received shipment from AmeriGas" value={notes} onChange={e => setNotes(e.target.value)} style={{ width: '100%' }} />
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!qty || isNaN(parseInt(qty)) || mut.isLoading} onClick={() => mut.mutate()}>
            {mut.isLoading ? <span className="spinner" /> : 'Adjust Stock'}
          </button>
        </div>
      </div>
    </div>
  )
}

export function InventoryPage() {
  const qc = useQueryClient()
  const [tab, setTab] = useState<'items'|'vendors'|'orders'|'sales'>('items')
  const [cat, setCat] = useState('all')
  const [showAddItem, setShowAddItem] = useState(false)
  const [showAddCat, setShowAddCat] = useState(false)
  const [editCat, setEditCat] = useState<any>(null)
  const [catForm, setCatForm] = useState({ name: '', icon: '📦' })
  const [showAddVendor, setShowAddVendor] = useState(false)
  const [editItem, setEditItem] = useState<any>(null)
  const [editVendor, setEditVendor] = useState<any>(null)
  const [adjustItem, setAdjustItem] = useState<any>(null)
  const [salesPeriod, setSalesPeriod] = useState('today')

  const [searchParams] = useSearchParams()

  const { data: categories = [] } = useQuery<any[]>('pos-cats', () => apiGet('/pos/categories'))
  const { data: items = [] }   = useQuery<any[]>('pos-items',   () => apiGet('/pos/items'))
  const { data: vendors = [] } = useQuery<any[]>('pos-vendors', () => apiGet('/pos/vendors'))

  // Auto-open edit/adjust from POS context menu
  useEffect(() => {
    const editId = searchParams.get('edit')
    const adjustId = searchParams.get('adjust')
    if (editId && (items as any[]).length > 0) {
      const item = (items as any[]).find(i => i.id === editId)
      if (item) { setEditItem(item); setTab('items') }
    }
    if (adjustId && (items as any[]).length > 0) {
      const item = (items as any[]).find(i => i.id === adjustId)
      if (item) { setAdjustItem(item); setTab('items') }
    }
  }, [searchParams, items])
  const { data: orders = [] }  = useQuery<any[]>('pos-orders',  () => apiGet('/pos/purchase-orders'))
  const { data: lowStock = [] } = useQuery<any[]>('pos-low-stock', () => apiGet('/pos/low-stock'))
  const { data: sales }        = useQuery(['pos-sales', salesPeriod], () => apiGet<any>(`/pos/transactions/sales?period=${salesPeriod}`))

  const deleteItemMut = useMutation(
    (id: string) => apiDelete('/pos/items/' + id),
    { onSuccess: () => qc.invalidateQueries('pos-items') }
  )

  const approvePOMut = useMutation(
    (id: string) => apiPatch(`/pos/purchase-orders/${id}`, { status: 'approved' }),
    { onSuccess: () => qc.invalidateQueries('pos-orders') }
  )

  const receivePOMut = useMutation(
    (id: string) => apiPatch(`/pos/purchase-orders/${id}`, { status: 'received' }),
    { onSuccess: () => { qc.invalidateQueries('pos-orders'); qc.invalidateQueries('pos-items') } }
  )

  const filteredItems = (items as any[]).filter(i => cat === 'all' || i.category === cat)

  const tabs = [
    { id: 'items',      label: 'Catalog',        icon: Package },
    { id: 'sales',      label: 'Sales',          icon: BarChart2 },
    { id: 'vendors',    label: 'Vendors',        icon: Truck },
    { id: 'orders',     label: `POs ${(orders as any[]).filter(o => o.status === 'draft').length > 0 ? '🔴' : ''}`, icon: ShoppingBag },
    { id: 'categories', label: 'Categories',     icon: Package },
  ]

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Inventory & Sales</h1>
          <p className="page-subtitle">
            {(items as any[]).length} items
            {(lowStock as any[]).length > 0 && <span style={{ color: 'var(--red)', marginLeft: 8 }}>· {(lowStock as any[]).length} low stock</span>}
            {(orders as any[]).filter(o => o.status === 'draft').length > 0 && <span style={{ color: 'var(--amber)', marginLeft: 8 }}>· {(orders as any[]).filter(o => o.status === 'draft').length} POs need approval</span>}
          </p>
        </div>
        {tab === 'items' && <button className="btn btn-primary" onClick={() => setShowAddItem(true)}><Plus size={15} /> Add Item</button>}
        {tab === 'vendors' && <button className="btn btn-primary" onClick={() => setShowAddVendor(true)}><Plus size={15} /> Add Vendor</button>}
        {tab === 'categories' && <button className="btn btn-primary" onClick={() => { setCatForm({ name: '', icon: '📦' }); setShowAddCat(true) }}><Plus size={15} /> Add Category</button>}
      </div>

      {/* Low stock alert */}
      {(lowStock as any[]).length > 0 && (
        <div style={{ background: 'rgba(255,71,87,.06)', border: '1px solid rgba(255,71,87,.2)', borderRadius: 10, padding: '10px 16px', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 10 }}>
          <AlertTriangle size={14} style={{ color: 'var(--red)', flexShrink: 0 }} />
          <div style={{ flex: 1 }}>
            <span style={{ fontSize: '.8rem', fontWeight: 700, color: 'var(--red)' }}>Low Stock Alert</span>
            <span style={{ fontSize: '.72rem', color: 'var(--text-3)', marginLeft: 8 }}>
              {(lowStock as any[]).map((i: any) => `${i.name} (${i.stock_qty} left)`).join(' · ')}
            </span>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id as any)} className={`btn btn-sm ${tab === t.id ? 'btn-primary' : 'btn-ghost'}`}>
            <t.icon size={13} /> {t.label}
          </button>
        ))}
      </div>

      {/* ── CATALOG TAB ── */}
      {tab === 'items' && (
        <>
          <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
            {CATS.map(c => (
              <button key={c} onClick={() => setCat(c)} className={`btn btn-sm ${cat===c?'btn-primary':'btn-ghost'}`} style={{ textTransform: 'capitalize', fontSize: '.72rem' }}>{c}</button>
            ))}
          </div>
          <div className="card" style={{ padding: 0 }}>
            <table className="data-table">
              <thead><tr>
                <th>Item</th><th>Category</th><th>Cost</th><th>Sell</th><th>Margin</th>
                <th>Tax</th><th>Stock</th><th>Min/Max</th><th>Vendor</th><th></th>
              </tr></thead>
              <tbody>
                {filteredItems.map((item: any) => {
                  const isLow = item.stock_qty <= item.stock_min && item.stock_max < 999
                  return (
                    <tr key={item.id}>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span>{item.icon}</span>
                          <div>
                            <div style={{ fontSize: '.82rem', fontWeight: 600, color: 'var(--text-0)' }}>{item.name}</div>
                            {item.shelf_label_enabled && (
                              <a href={`/shelf/${item.id}`} target="_blank" rel="noreferrer" style={{ fontSize: '.62rem', color: 'var(--gold)', display: 'flex', alignItems: 'center', gap: 2 }}>
                                <QrCode size={9} /> Shelf Label
                              </a>
                            )}
                          </div>
                        </div>
                      </td>
                      <td><span style={{ fontSize: '.72rem', textTransform: 'capitalize' }}>{item.category}</span></td>
                      <td className="mono">{formatCurrency(item.cost_price)}</td>
                      <td className="mono" style={{ color: 'var(--gold)', fontWeight: 600 }}>{formatCurrency(item.sell_price)}</td>
                      <td>
                        <span style={{ fontSize: '.72rem', color: item.margin_pct > 40 ? 'var(--green)' : item.margin_pct > 20 ? 'var(--amber)' : 'var(--red)' }}>
                          {item.margin_pct ? `${parseFloat(item.margin_pct).toFixed(1)}%` : '—'}
                        </span>
                      </td>
                      <td className="mono" style={{ fontSize: '.72rem' }}>{(item.tax_rate * 100).toFixed(0)}%</td>
                      <td>
                        <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: isLow ? 'var(--red)' : item.stock_qty < item.stock_max * .5 ? 'var(--amber)' : 'var(--green)' }}>
                          {item.stock_max >= 999 ? '∞' : item.stock_qty}
                        </span>
                        {isLow && <span style={{ fontSize: '.62rem', color: 'var(--red)', marginLeft: 4 }}>LOW</span>}
                      </td>
                      <td className="mono" style={{ fontSize: '.72rem' }}>{item.stock_max >= 999 ? '—' : `${item.stock_min}/${item.stock_max}`}</td>
                      <td style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>{(vendors as any[]).find(v => v.id === item.vendor_id)?.name || '—'}</td>
                      <td>
                        <div style={{ display: 'flex', gap: 4 }}>
                          {item.stock_max < 999 && (
                            <button className="btn btn-ghost btn-sm" onClick={() => setAdjustItem(item)} title="Adjust Stock">
                              <RefreshCw size={11} />
                            </button>
                          )}
                          <button className="btn btn-ghost btn-sm" onClick={() => setEditItem(item)} title="Edit">
                            <Edit2 size={11} />
                          </button>
                          <button className="btn btn-ghost btn-sm" title="Delete" onClick={() => { if(window.confirm('Remove ' + item.name + ' from catalog?')) deleteItemMut.mutate(item.id) }} style={{ color: 'var(--red)' }}>
                            <Trash2 size={11} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
                {filteredItems.length === 0 && (
                  <tr><td colSpan={10} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 32 }}>No items in this category.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* ── SALES TAB ── */}
      {tab === 'sales' && (
        <>
          <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
            {[['today','Today'],['week','7 Days'],['month','30 Days']].map(([v,l]) => (
              <button key={v} onClick={() => setSalesPeriod(v)} className={`btn btn-sm ${salesPeriod===v?'btn-primary':'btn-ghost'}`}>{l}</button>
            ))}
          </div>

          {sales && (
            <>
              {/* Summary cards */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12, marginBottom: 20 }}>
                {[
                  { label: 'Revenue',     val: formatCurrency(parseFloat((sales as any).summary?.total_revenue||0)), color: 'var(--gold)' },
                  { label: 'Transactions', val: (sales as any).summary?.tx_count || 0, color: 'var(--text-0)' },
                  { label: 'Avg Ticket',  val: formatCurrency(parseFloat((sales as any).summary?.avg_ticket||0)), color: 'var(--text-0)' },
                  { label: 'Tax Collected', val: formatCurrency(parseFloat((sales as any).summary?.total_tax||0)), color: 'var(--text-3)' },
                ].map(s => (
                  <div key={s.label} className="card" style={{ padding: '14px 16px' }}>
                    <div style={{ fontSize: '.62rem', fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase' as const, letterSpacing: '.08em', marginBottom: 6 }}>{s.label}</div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: '1rem', fontWeight: 700, color: s.color }}>{s.val}</div>
                  </div>
                ))}
              </div>

              {/* Payment method breakdown */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10, marginBottom: 20 }}>
                {[
                  { label: '💵 Cash',        val: (sales as any).summary?.cash_total },
                  { label: '💳 Card',        val: (sales as any).summary?.card_total },
                  { label: '⚡ Charge Acct', val: (sales as any).summary?.charge_total },
                ].map(s => (
                  <div key={s.label} className="card" style={{ padding: '12px 14px' }}>
                    <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginBottom: 4 }}>{s.label}</div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: '.9rem', fontWeight: 700, color: 'var(--text-0)' }}>{formatCurrency(parseFloat(s.val||0))}</div>
                  </div>
                ))}
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                {/* Top items */}
                <div className="card">
                  <div className="card-title" style={{ marginBottom: 12 }}>Top Items</div>
                  {(sales as any).topItems?.length === 0 && <div style={{ color: 'var(--text-3)', fontSize: '.78rem' }}>No sales data.</div>}
                  {(sales as any).topItems?.map((item: any, i: number) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: '1px solid var(--border-0)' }}>
                      <div style={{ width: 22, height: 22, borderRadius: 6, background: 'var(--bg-3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '.68rem', fontWeight: 800, color: 'var(--text-3)', flexShrink: 0 }}>{i+1}</div>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: '.78rem', fontWeight: 500, color: 'var(--text-0)' }}>{item.item_name}</div>
                        <div style={{ fontSize: '.65rem', color: 'var(--text-3)' }}>{item.total_qty} units sold</div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontFamily: 'var(--font-mono)', fontSize: '.78rem', color: 'var(--gold)' }}>{formatCurrency(item.total_revenue)}</div>
                        <div style={{ fontSize: '.62rem', color: 'var(--green)' }}>+{formatCurrency(item.gross_profit)} profit</div>
                      </div>
                    </div>
                  ))}
                </div>

                {/* By category */}
                <div className="card">
                  <div className="card-title" style={{ marginBottom: 12 }}>By Category</div>
                  {(sales as any).byCategory?.length === 0 && <div style={{ color: 'var(--text-3)', fontSize: '.78rem' }}>No sales data.</div>}
                  {(sales as any).byCategory?.map((cat: any, i: number) => {
                    const total = (sales as any).byCategory.reduce((s: number, c: any) => s + parseFloat(c.revenue), 0)
                    const pct = total > 0 ? (parseFloat(cat.revenue) / total) * 100 : 0
                    return (
                      <div key={i} style={{ marginBottom: 10 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                          <span style={{ fontSize: '.75rem', textTransform: 'capitalize', color: 'var(--text-0)' }}>{cat.category}</span>
                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: '.75rem', color: 'var(--gold)' }}>{formatCurrency(cat.revenue)}</span>
                        </div>
                        <div style={{ height: 4, background: 'var(--bg-3)', borderRadius: 2, overflow: 'hidden' }}>
                          <div style={{ height: '100%', width: `${pct}%`, background: 'var(--gold)', borderRadius: 2 }} />
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>

              {/* Hourly chart (today only) */}
              {salesPeriod === 'today' && (sales as any).byHour?.length > 0 && (
                <div className="card" style={{ marginTop: 16 }}>
                  <div className="card-title" style={{ marginBottom: 12 }}>Sales by Hour — Today</div>
                  <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 80 }}>
                    {Array.from({ length: 24 }, (_, h) => {
                      const hourData = (sales as any).byHour?.find((x: any) => x.hour === h)
                      const maxRev = Math.max(...((sales as any).byHour?.map((x: any) => parseFloat(x.revenue)) || [1]))
                      const pct = hourData ? (parseFloat(hourData.revenue) / maxRev) * 100 : 0
                      return (
                        <div key={h} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }} title={hourData ? `${h}:00 — ${formatCurrency(hourData.revenue)}` : `${h}:00`}>
                          <div style={{ width: '100%', height: `${Math.max(pct, 2)}%`, background: pct > 0 ? 'var(--gold)' : 'var(--bg-3)', borderRadius: '2px 2px 0 0', minHeight: 3, transition: 'height .2s' }} />
                          {(h % 4 === 0) && <div style={{ fontSize: '.52rem', color: 'var(--text-3)' }}>{h}</div>}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </>
          )}
        </>
      )}

      {/* ── VENDORS TAB ── */}
      {tab === 'vendors' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px,1fr))', gap: 14 }}>
          {(vendors as any[]).length === 0 && (
            <div className="empty-state" style={{ gridColumn: '1/-1', padding: 40 }}>
              <Truck size={40} />
              <h3>No vendors yet</h3>
              <p>Add vendors to enable auto-draft purchase orders when stock runs low.</p>
              <button className="btn btn-primary" onClick={() => setShowAddVendor(true)}><Plus size={14} /> Add Vendor</button>
            </div>
          )}
          {(vendors as any[]).map((v: any) => {
            const vendorItems = (items as any[]).filter(i => i.vendor_id === v.id)
            return (
              <div key={v.id} className="card">
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{ width: 40, height: 40, borderRadius: 10, background: 'rgba(201,162,39,.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <Truck size={18} style={{ color: 'var(--gold)' }} />
                    </div>
                    <div>
                      <div style={{ fontSize: '.88rem', fontWeight: 700, color: 'var(--text-0)' }}>{v.name}</div>
                      {v.contact_name && <div style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>{v.contact_name}</div>}
                    </div>
                  </div>
                  <button className="btn btn-ghost btn-sm" onClick={() => setEditVendor(v)} style={{ padding: '4px 8px' }}><Edit2 size={12} /></button>
                </div>
                {v.email && <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginBottom: 3 }}>📧 {v.email}</div>}
                {v.phone && <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginBottom: 8 }}>📞 {v.phone}</div>}
                <div style={{ display: 'flex', gap: 8 }}>
                  <span className="badge badge-muted">Lead time: {v.lead_time_days}d</span>
                  <span className="badge badge-muted">{vendorItems.length} items</span>
                </div>
                {vendorItems.length > 0 && (
                  <div style={{ marginTop: 10, fontSize: '.68rem', color: 'var(--text-3)' }}>
                    {vendorItems.map((i: any) => i.name).join(', ')}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* ── PURCHASE ORDERS TAB ── */}
      {tab === 'orders' && (
        <>
          {(orders as any[]).length === 0 ? (
            <div className="empty-state" style={{ padding: 40 }}>
              <ShoppingBag size={40} />
              <h3>No purchase orders</h3>
              <p>Purchase orders are auto-drafted when items hit their minimum stock level.</p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {(orders as any[]).map((po: any) => (
                <div key={po.id} className="card">
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: '.82rem', fontWeight: 700, color: 'var(--text-0)' }}>{po.po_number}</span>
                        <span className={`badge ${po.status==='draft'?'badge-amber':po.status==='approved'?'badge-blue':po.status==='received'?'badge-green':'badge-muted'}`}>{po.status}</span>
                      </div>
                      <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 2 }}>
                        {po.vendor_name} · {new Date(po.created_at).toLocaleDateString()} · {po.item_count} items
                      </div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontFamily: 'var(--font-mono)', fontSize: '.9rem', fontWeight: 700, color: 'var(--gold)' }}>{formatCurrency(po.subtotal)}</div>
                      <div style={{ display: 'flex', gap: 6, marginTop: 6, justifyContent: 'flex-end' }}>
                        {po.status === 'draft' && (
                          <button className="btn btn-sm btn-primary" onClick={() => approvePOMut.mutate(po.id)} disabled={approvePOMut.isLoading}>
                            <Check size={12} /> Approve
                          </button>
                        )}
                        {po.status === 'approved' && (
                          <button className="btn btn-sm btn-ghost" onClick={() => receivePOMut.mutate(po.id)} disabled={receivePOMut.isLoading}>
                            <Package size={12} /> Mark Received
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                  <table className="data-table" style={{ fontSize: '.75rem' }}>
                    <thead><tr><th>Item</th><th>Qty</th><th>Unit Cost</th><th>Total</th></tr></thead>
                    <tbody>
                      {po.items?.map((item: any) => (
                        <tr key={item.id}>
                          <td>{item.item_name}</td>
                          <td className="mono">{item.qty_ordered}</td>
                          <td className="mono">{formatCurrency(item.unit_cost)}</td>
                          <td className="mono">{formatCurrency(item.subtotal)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* CATEGORIES TAB */}
      {tab === 'categories' && (
        <div>
          <div style={{ fontSize: '.78rem', color: 'var(--text-3)', marginBottom: 16 }}>
            Categories appear as filter tabs on the POS screen. Reorder by changing sort order.
          </div>
          <div className="card" style={{ padding: 0 }}>
            <table className="data-table">
              <thead><tr><th>Icon</th><th>Name</th><th>Sort Order</th><th>Items</th><th></th></tr></thead>
              <tbody>
                {(categories as any[]).length === 0 && (
                  <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 32 }}>No categories yet.</td></tr>
                )}
                {(categories as any[]).map((cat: any) => (
                  <tr key={cat.id}>
                    <td style={{ fontSize: '1.2rem' }}>{cat.icon}</td>
                    <td style={{ fontWeight: 600, color: 'var(--text-0)' }}>{cat.name}</td>
                    <td className="mono">{cat.sort_order}</td>
                    <td style={{ fontSize: '.75rem', color: 'var(--text-3)' }}>
                      {(items as any[]).filter(i => i.custom_category_id === cat.id || i.category === cat.name.toLowerCase()).length} items
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button className="btn btn-ghost btn-sm" onClick={() => { setEditCat(cat); setCatForm({ name: cat.name, icon: cat.icon }); setShowAddCat(true) }}>
                          <Edit2 size={11} />
                        </button>
                        <button className="btn btn-ghost btn-sm" style={{ color: 'var(--red)' }} onClick={async () => {
                          if (window.confirm('Delete ' + cat.name + '?')) {
                            await apiDelete('/pos/categories/' + cat.id)
                            qc.invalidateQueries('pos-cats')
                          }
                        }}>
                          <Trash2 size={11} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {showAddItem && <ItemModal vendors={vendors as any[]} categories={categories as any[]} onClose={() => setShowAddItem(false)} />
      }
      {editItem && <ItemModal item={editItem} vendors={vendors as any[]} categories={categories as any[]} onClose={() => setEditItem(null)} />}
      {showAddVendor && <VendorModal onClose={() => setShowAddVendor(false)} />}
      {editVendor && <VendorModal vendor={editVendor} onClose={() => setEditVendor(null)} />}
      {adjustItem && <StockAdjustModal item={adjustItem} onClose={() => setAdjustItem(null)} />}
      {showAddCat && (
        <div className="modal-overlay" onClick={() => { setShowAddCat(false); setEditCat(null) }}>
          <div className="modal" style={{ maxWidth: 360 }} onClick={e => e.stopPropagation()}>
            <div className="modal-title">{editCat ? 'Edit Category' : 'Add Category'}</div>
            <div style={{ display: 'grid', gridTemplateColumns: '64px 1fr', gap: 10, marginBottom: 14 }}>
              <div>
                <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase' as const, letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>Icon</label>
                <input className="input" value={catForm.icon} onChange={e => setCatForm(f => ({ ...f, icon: e.target.value }))} style={{ textAlign: 'center', fontSize: '1.4rem' }} />
              </div>
              <div>
                <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase' as const, letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>Name *</label>
                <input className="input" placeholder="e.g. Groceries" value={catForm.name} onChange={e => setCatForm(f => ({ ...f, name: e.target.value }))} style={{ width: '100%' }} autoFocus />
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={() => { setShowAddCat(false); setEditCat(null) }}>Cancel</button>
              <button className="btn btn-primary" disabled={!catForm.name} onClick={async () => {
                if (editCat) {
                  await apiPatch('/pos/categories/' + editCat.id, catForm)
                } else {
                  await apiPost('/pos/categories', catForm)
                }
                qc.invalidateQueries('pos-cats')
                setShowAddCat(false)
                setEditCat(null)
              }}>
                {editCat ? 'Save' : 'Add Category'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
