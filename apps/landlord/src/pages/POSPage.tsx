import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { apiGet, apiPost, apiPatch, apiDel } from '../lib/api'
const fmt = (n: any) => n != null ? `$${Number(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}` : '—'
const pct = (n: any) => n != null ? `${(Number(n)*100).toFixed(2)}%` : '—'

const STATUS_MAP: Record<string,string> = { completed:'badge-green', voided:'badge-red', refunded:'badge-amber', partial_refund:'badge-amber' }
const METHOD_MAP: Record<string,string> = { cash:'badge-green', card:'badge-blue', charge:'badge-amber' }
const TAX_TYPES = ['state','city','county','special']
const CATEGORIES = ['fuel','amenity','laundry','parking','fee','misc']

interface CartItem { id:string; name:string; price:number; qty:number; tax:number; cat:string; icon:string; chargeEligible:boolean }

export function POSPage() {
  const qc = useQueryClient()
  const [tab, setTab] = useState<'register'|'history'|'items'|'taxes'|'discounts'>('register')

  // Register state
  const [cart, setCart] = useState<CartItem[]>([])
  const [method, setMethod] = useState<'cash'|'card'|'charge'>('cash')
  const [tenantId, setTenantId] = useState('')
  const [cashGiven, setCashGiven] = useState('')
  const [filterCat, setFilterCat] = useState('all')
  const [receipt, setReceipt] = useState<any>(null)
  const [appliedDiscount, setAppliedDiscount] = useState<any>(null)
  const [discountCode, setDiscountCode] = useState('')
  const [openItem, setOpenItem] = useState({ name:'', price:'', show:false })
  const [noteModal, setNoteModal] = useState<{show:boolean; txId:string}>({show:false,txId:''})
  const [refundModal, setRefundModal] = useState<{show:boolean; tx:any}>({show:false,tx:null})
  const [refundAmt, setRefundAmt] = useState('')
  const [refundReason, setRefundReason] = useState('')

  // Item management state
  const [editItem, setEditItem] = useState<any>(null)
  const [newItem, setNewItem] = useState({ name:'', category:'misc', icon:'📦', sell_price:'', cost_price:'', tax_rate:'0', charge_eligible:true, stock_qty:'0', stock_min:'5', stock_max:'50' })

  // Tax rate state
  const [newTax, setNewTax] = useState({ name:'', rate:'', tax_type:'state', applies_to:'all' })

  // Discount state
  const [newDiscount, setNewDiscount] = useState({ name:'', type:'percent', value:'', code:'' })

  // Queries
  const { data: items = [] } = useQuery<any[]>('pos-items', () => apiGet('/pos/items'))
  const { data: tenants = [] } = useQuery<any[]>('tenants', () => apiGet('/tenants'))
  const { data: taxRates = [] } = useQuery<any[]>('pos-tax-rates', () => apiGet('/pos/tax-rates'), { enabled: tab==='taxes' || tab==='register' })
  const { data: discounts = [] } = useQuery<any[]>('pos-discounts', () => apiGet('/pos/discounts'), { enabled: tab==='discounts' || tab==='register' })
  const { data: txns = [], isLoading: txLoading } = useQuery<any[]>('pos-transactions', () => apiGet('/pos/transactions'), { enabled: tab==='history' })

  const categories = ['all', ...Array.from(new Set((items as any[]).map((i:any) => i.category)))]
  const visibleItems = filterCat === 'all' ? (items as any[]) : (items as any[]).filter((i:any) => i.category === filterCat)

  // Cart logic
  const addToCart = (item: any) => {
    setCart(c => {
      const ex = c.find(x => x.id === item.id)
      if (ex) return c.map(x => x.id===item.id ? {...x,qty:x.qty+1} : x)
      return [...c, { id:item.id, name:item.name, price:Number(item.sell_price), qty:1, tax:Number(item.tax_rate), cat:item.category, icon:item.icon, chargeEligible:item.charge_eligible }]
    })
  }
  const addOpenItem = () => {
    if (!openItem.name || !openItem.price) return
    setCart(c => [...c, { id:'open-'+Date.now(), name:openItem.name, price:Number(openItem.price), qty:1, tax:0, cat:'misc', icon:'📝', chargeEligible:false }])
    setOpenItem({ name:'', price:'', show:false })
  }
  const updateQty = (id:string, delta:number) => setCart(c => c.map(x => x.id===id ? {...x,qty:Math.max(0,x.qty+delta)} : x).filter(x=>x.qty>0))

  const subtotal = cart.reduce((s,i) => s+i.price*i.qty, 0)
  const discountAmt = appliedDiscount ? (appliedDiscount.type==='percent' ? subtotal*(appliedDiscount.value/100) : Math.min(appliedDiscount.value, subtotal)) : 0
  const discountedSubtotal = subtotal - discountAmt
  const taxAmount = cart.reduce((s,i) => s+i.price*i.qty*i.tax, 0)
  const surcharge = method==='charge' ? discountedSubtotal*0.01 : 0
  const total = discountedSubtotal + taxAmount + surcharge
  const changeDue = method==='cash' ? Math.max(0, Number(cashGiven)-total) : 0
  const chargeBlocked = method==='charge' && cart.some(i => !i.chargeEligible)
  const canCharge = method==='charge' && !!tenantId && !chargeBlocked

  const applyDiscountCode = () => {
    const d = (discounts as any[]).find((x:any) => x.code?.toLowerCase() === discountCode.toLowerCase())
    if (d) { setAppliedDiscount(d); setDiscountCode('') }
  }

  // Checkout
  const checkoutMut = useMutation(
    () => apiPost('/pos/transactions', {
      items: cart.map(i => ({ id:i.id.startsWith('open-')?null:i.id, name:i.name, qty:i.qty, price:i.price, tax:i.tax, cat:i.cat })),
      paymentMethod:method, tenantId:tenantId||null,
      subtotal:discountedSubtotal, taxAmount, surcharge, total, changeGiven:changeDue,
      discountAmount:discountAmt, discountReason:appliedDiscount?.name||null
    }),
    {
      onSuccess: (res:any) => {
        setReceipt({ ...res.data, cartItems:cart, subtotal, discountAmt, taxAmount, surcharge, total, changeDue, method })
        setCart([]); setCashGiven(''); setTenantId(''); setAppliedDiscount(null)
        qc.invalidateQueries('pos-transactions'); qc.invalidateQueries('pos-items')
      }
    }
  )

  // Item mutations
  const toggleChargeMut = useMutation(
    ({ id, val }:{ id:string; val:boolean }) => apiPatch(`/pos/items/${id}`, { chargeEligible:val }),
    { onSuccess: () => qc.invalidateQueries('pos-items') }
  )
  const toggleActiveMut = useMutation(
    ({ id, val }:{ id:string; val:boolean }) => apiPatch(`/pos/items/${id}`, { isActive:val }),
    { onSuccess: () => qc.invalidateQueries('pos-items') }
  )
  const createItemMut = useMutation(
    () => apiPost('/pos/items', { ...newItem, costPrice:Number(newItem.cost_price), sellPrice:Number(newItem.sell_price), taxRate:Number(newItem.tax_rate), chargeEligible:newItem.charge_eligible, stockQty:Number(newItem.stock_qty), stockMin:Number(newItem.stock_min), stockMax:Number(newItem.stock_max) }),
    { onSuccess: () => { qc.invalidateQueries('pos-items'); setNewItem({ name:'', category:'misc', icon:'📦', sell_price:'', cost_price:'', tax_rate:'0', charge_eligible:true, stock_qty:'0', stock_min:'5', stock_max:'50' }) } }
  )
  const updateItemMut = useMutation(
    (data:any) => apiPatch(`/pos/items/${editItem.id}`, data),
    { onSuccess: () => { qc.invalidateQueries('pos-items'); setEditItem(null) } }
  )

  // Tax mutations
  const createTaxMut = useMutation(
    () => apiPost('/pos/tax-rates', { ...newTax, rate:Number(newTax.rate)/100, taxType:newTax.tax_type, appliesTo:newTax.applies_to==='all'?['all']:[newTax.applies_to] }),
    { onSuccess: () => { qc.invalidateQueries('pos-tax-rates'); setNewTax({ name:'', rate:'', tax_type:'state', applies_to:'all' }) } }
  )
  const deleteTaxMut = useMutation(
    (id:string) => apiDel(`/pos/tax-rates/${id}`),
    { onSuccess: () => qc.invalidateQueries('pos-tax-rates') }
  )

  // Discount mutations
  const createDiscountMut = useMutation(
    () => apiPost('/pos/discounts', { ...newDiscount, value:Number(newDiscount.value) }),
    { onSuccess: () => { qc.invalidateQueries('pos-discounts'); setNewDiscount({ name:'', type:'percent', value:'', code:'' }) } }
  )
  const deleteDiscountMut = useMutation(
    (id:string) => apiDel(`/pos/discounts/${id}`),
    { onSuccess: () => qc.invalidateQueries('pos-discounts') }
  )

  // Refund mutation
  const refundMut = useMutation(
    () => apiPost(`/pos/transactions/${refundModal.tx?.id}/refund`, { amount:Number(refundAmt)||refundModal.tx?.total, reason:refundReason, refundMethod:refundModal.tx?.payment_method }),
    { onSuccess: () => { qc.invalidateQueries('pos-transactions'); setRefundModal({show:false,tx:null}); setRefundAmt(''); setRefundReason('') } }
  )
  const voidMut = useMutation(
    (id:string) => apiPost(`/pos/transactions/${id}/void`, { reason:'Voided by cashier' }),
    { onSuccess: () => qc.invalidateQueries('pos-transactions') }
  )

  const TABS = [
    { key:'register', label:'Register' },
    { key:'history',  label:'History' },
    { key:'items',    label:'Items' },
    { key:'taxes',    label:'Tax Rates' },
    { key:'discounts',label:'Discounts' },
  ]

  if (receipt) return (
    <div>
      <div className="page-header">
        <div><h1 className="page-title">Point of Sale</h1></div>
      </div>
      <div style={{maxWidth:420,margin:'0 auto'}}>
        <div className="card" style={{textAlign:'center',padding:32}}>
          <div style={{fontSize:'2rem',marginBottom:8}}>✅</div>
          <div style={{fontWeight:700,fontSize:'1.1rem',marginBottom:4}}>Sale Complete</div>
          <div style={{color:'var(--text-3)',fontSize:'.82rem',marginBottom:24}}>Transaction recorded</div>
          <table className="data-table" style={{marginBottom:16}}>
            <tbody>
              {receipt.cartItems.map((i:any,idx:number) => (
                <tr key={idx}><td>{i.icon} {i.name}</td><td className="mono">×{i.qty}</td><td className="mono">{fmt(i.price*i.qty)}</td></tr>
              ))}
            </tbody>
          </table>
          <div style={{display:'grid',gap:4,fontSize:'.88rem',marginBottom:16}}>
            <div style={{display:'flex',justifyContent:'space-between'}}><span style={{color:'var(--text-3)'}}>Subtotal</span><span>{fmt(receipt.subtotal)}</span></div>
            {receipt.discountAmt > 0 && <div style={{display:'flex',justifyContent:'space-between',color:'var(--green)'}}><span>Discount</span><span>−{fmt(receipt.discountAmt)}</span></div>}
            {receipt.taxAmount > 0 && <div style={{display:'flex',justifyContent:'space-between'}}><span style={{color:'var(--text-3)'}}>Tax</span><span>{fmt(receipt.taxAmount)}</span></div>}
            {receipt.surcharge > 0 && <div style={{display:'flex',justifyContent:'space-between'}}><span style={{color:'var(--text-3)'}}>FlexCharge fee</span><span>{fmt(receipt.surcharge)}</span></div>}
            <div style={{display:'flex',justifyContent:'space-between',fontWeight:700,fontSize:'1rem',borderTop:'1px solid var(--border-1)',paddingTop:8,marginTop:4}}>
              <span>Total</span><span style={{color:'var(--gold)'}}>{fmt(receipt.total)}</span>
            </div>
            {receipt.method==='cash' && receipt.changeDue>0 && <div style={{display:'flex',justifyContent:'space-between',color:'var(--green)',fontWeight:600}}><span>Change Due</span><span>{fmt(receipt.changeDue)}</span></div>}
          </div>
          <button className="btn btn-primary" style={{width:'100%'}} onClick={()=>setReceipt(null)}>New Sale</button>
        </div>
      </div>
    </div>
  )

  return (
    <div>
      <div className="page-header">
        <div><h1 className="page-title">Point of Sale</h1><p className="page-subtitle">Register · Inventory · Taxes · Discounts</p></div>
        <div style={{display:'flex',gap:6}}>
          {TABS.map(t => <button key={t.key} className={`tab-btn ${tab===t.key?'active':''}`} onClick={()=>setTab(t.key as any)}>{t.label}</button>)}
        </div>
      </div>

      {/* ── REGISTER ── */}
      {tab==='register' && (
        <div style={{display:'grid',gridTemplateColumns:'1fr 340px',gap:16,alignItems:'start'}}>
          <div>
            {/* Category filter */}
            <div style={{display:'flex',gap:6,marginBottom:12,flexWrap:'wrap'}}>
              {categories.map(c => (
                <button key={c} onClick={()=>setFilterCat(c)} className={`tab-btn ${filterCat===c?'active':''}`}
                  style={{fontSize:'.78rem',padding:'4px 12px',textTransform:'capitalize'}}>{c}</button>
              ))}
              <button onClick={()=>setOpenItem(o=>({...o,show:true}))} className="tab-btn"
                style={{fontSize:'.78rem',padding:'4px 12px',marginLeft:'auto'}}>+ Open Item</button>
            </div>
            {/* Item grid */}
            <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(130px,1fr))',gap:10}}>
              {visibleItems.filter((i:any)=>i.is_active).map((item:any) => (
                <button key={item.id} onClick={()=>addToCart(item)}
                  style={{background:'var(--bg-2)',border:'1px solid var(--border-1)',borderRadius:'var(--r-lg)',padding:16,cursor:'pointer',textAlign:'left'}}
                  onMouseEnter={e=>(e.currentTarget.style.borderColor='var(--gold)')}
                  onMouseLeave={e=>(e.currentTarget.style.borderColor='var(--border-1)')}>
                  <div style={{fontSize:'1.4rem',marginBottom:6}}>{item.icon}</div>
                  <div style={{fontSize:'.82rem',fontWeight:600,color:'var(--text-0)',marginBottom:2}}>{item.name}</div>
                  <div style={{fontSize:'.88rem',color:'var(--gold)',fontWeight:700}}>{fmt(item.sell_price)}</div>
                  <div style={{display:'flex',gap:4,marginTop:4,flexWrap:'wrap'}}>
                    {item.charge_eligible && <span style={{fontSize:'.65rem',background:'var(--gold-bg)',color:'var(--gold)',padding:'1px 4px',borderRadius:3}}>⚡ charge</span>}
                    {item.stock_qty < 999 && <span style={{fontSize:'.65rem',color:item.stock_qty<=item.stock_min?'var(--amber)':'var(--text-3)'}}>{item.stock_qty} left</span>}
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Cart */}
          <div className="card" style={{position:'sticky',top:80}}>
            <div className="card-header"><span className="card-title">Current Sale</span>
              {cart.length>0 && <button onClick={()=>setCart([])} style={{background:'none',border:'none',color:'var(--text-3)',cursor:'pointer',fontSize:'.75rem'}}>Clear</button>}
            </div>
            {cart.length===0 ? (
              <div style={{color:'var(--text-3)',fontSize:'.85rem',padding:'24px 0',textAlign:'center'}}>No items added</div>
            ) : (
              <div style={{marginBottom:12}}>
                {cart.map(i => (
                  <div key={i.id} style={{display:'flex',alignItems:'center',gap:6,padding:'7px 0',borderBottom:'1px solid var(--border-1)'}}>
                    <span style={{fontSize:'1rem'}}>{i.icon}</span>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:'.8rem',fontWeight:500,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{i.name}</div>
                      {!i.chargeEligible && method==='charge' && <div style={{fontSize:'.65rem',color:'var(--red)'}}>not charge eligible</div>}
                    </div>
                    <div style={{display:'flex',alignItems:'center',gap:4}}>
                      <button onClick={()=>updateQty(i.id,-1)} style={{background:'var(--bg-3)',border:'none',borderRadius:3,width:20,height:20,cursor:'pointer',fontWeight:700,fontSize:'.8rem'}}>−</button>
                      <span style={{fontSize:'.82rem',fontWeight:600,minWidth:14,textAlign:'center'}}>{i.qty}</span>
                      <button onClick={()=>updateQty(i.id,1)} style={{background:'var(--bg-3)',border:'none',borderRadius:3,width:20,height:20,cursor:'pointer',fontWeight:700,fontSize:'.8rem'}}>+</button>
                    </div>
                    <div style={{fontSize:'.82rem',fontWeight:600,minWidth:44,textAlign:'right'}}>{fmt(i.price*i.qty)}</div>
                  </div>
                ))}
              </div>
            )}

            {/* Discount */}
            {appliedDiscount ? (
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',background:'var(--gold-bg)',borderRadius:6,padding:'6px 10px',marginBottom:10,fontSize:'.8rem'}}>
                <span style={{color:'var(--gold)',fontWeight:600}}>🏷 {appliedDiscount.name} −{appliedDiscount.type==='percent'?`${appliedDiscount.value}%`:fmt(appliedDiscount.value)}</span>
                <button onClick={()=>setAppliedDiscount(null)} style={{background:'none',border:'none',cursor:'pointer',color:'var(--text-3)'}}>✕</button>
              </div>
            ) : (
              <div style={{display:'flex',gap:6,marginBottom:10}}>
                <input className="form-input" placeholder="Discount code" value={discountCode}
                  onChange={e=>setDiscountCode(e.target.value)} style={{flex:1,fontSize:'.78rem',padding:'4px 8px'}} />
                <button className="btn btn-ghost btn-sm" onClick={applyDiscountCode}>Apply</button>
              </div>
            )}

            {/* Totals */}
            <div style={{fontSize:'.82rem',display:'grid',gap:3,marginBottom:12}}>
              <div style={{display:'flex',justifyContent:'space-between'}}><span style={{color:'var(--text-3)'}}>Subtotal</span><span>{fmt(subtotal)}</span></div>
              {discountAmt>0 && <div style={{display:'flex',justifyContent:'space-between',color:'var(--green)'}}><span>Discount</span><span>−{fmt(discountAmt)}</span></div>}
              {taxAmount>0 && <div style={{display:'flex',justifyContent:'space-between'}}><span style={{color:'var(--text-3)'}}>Tax</span><span>{fmt(taxAmount)}</span></div>}
              {surcharge>0 && <div style={{display:'flex',justifyContent:'space-between'}}><span style={{color:'var(--text-3)'}}>FlexCharge (1%)</span><span>{fmt(surcharge)}</span></div>}
              <div style={{display:'flex',justifyContent:'space-between',fontWeight:700,fontSize:'.95rem',borderTop:'1px solid var(--border-1)',paddingTop:6,marginTop:2}}>
                <span>Total</span><span style={{color:'var(--gold)'}}>{fmt(total)}</span>
              </div>
            </div>

            {/* Payment method */}
            <div style={{marginBottom:10}}>
              <div style={{fontSize:'.72rem',color:'var(--text-3)',marginBottom:5}}>Payment method</div>
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:5}}>
                {(['cash','card','charge'] as const).map(m => (
                  <button key={m} onClick={()=>setMethod(m)}
                    style={{padding:'7px 0',border:`1px solid ${method===m?'var(--gold)':'var(--border-1)'}`,background:method===m?'var(--gold-bg)':'var(--bg-2)',borderRadius:'var(--r-md)',cursor:'pointer',fontSize:'.75rem',fontWeight:method===m?700:400,color:method===m?'var(--gold)':'var(--text-2)',textTransform:'capitalize'}}>
                    {m==='charge'?'⚡ charge':m}
                  </button>
                ))}
              </div>
            </div>

            {method==='cash' && (
              <div style={{marginBottom:10}}>
                <input className="form-input" type="number" placeholder="Cash given" value={cashGiven}
                  onChange={e=>setCashGiven(e.target.value)} style={{width:'100%'}} />
                {cashGiven && Number(cashGiven)>=total && <div style={{fontSize:'.82rem',color:'var(--green)',fontWeight:600,marginTop:4}}>Change: {fmt(changeDue)}</div>}
              </div>
            )}

            {method==='charge' && (
              <div style={{marginBottom:10}}>
                <select className="form-select" value={tenantId} onChange={e=>setTenantId(e.target.value)} style={{width:'100%'}}>
                  <option value="">Select tenant…</option>
                  {(tenants as any[]).map((t:any) => <option key={t.id} value={t.id}>{t.first_name} {t.last_name} — {t.unit_number||'no unit'}</option>)}
                </select>
                {chargeBlocked && <div style={{fontSize:'.72rem',color:'var(--red)',marginTop:4}}>⚠ Cart contains items not eligible for charge account</div>}
              </div>
            )}

            <button className="btn btn-primary" style={{width:'100%'}}
              disabled={cart.length===0||checkoutMut.isLoading||(method==='charge'&&(!tenantId||chargeBlocked))}
              onClick={()=>checkoutMut.mutate()}>
              {checkoutMut.isLoading?'Processing…':`Charge ${fmt(total)}`}
            </button>
          </div>
        </div>
      )}

      {/* ── HISTORY ── */}
      {tab==='history' && (
        <div className="card" style={{padding:0}}>
          {txLoading ? <div style={{padding:32,textAlign:'center',color:'var(--text-3)'}}>Loading…</div> : (
            <table className="data-table">
              <thead><tr><th>Date</th><th>Items</th><th>Subtotal</th><th>Total</th><th>Method</th><th>Status</th><th>Actions</th></tr></thead>
              <tbody>
                {(txns as any[]).length ? (txns as any[]).map((t:any) => (
                  <tr key={t.id}>
                    <td className="mono">{new Date(t.created_at).toLocaleDateString()}</td>
                    <td style={{color:'var(--text-3)',fontSize:'.82rem'}}>{t.item_count} items</td>
                    <td className="mono">{fmt(t.subtotal)}</td>
                    <td className="mono" style={{fontWeight:600}}>{fmt(t.total)}</td>
                    <td><span className={`badge ${METHOD_MAP[t.payment_method]||'badge-muted'}`}>{t.payment_method}</span></td>
                    <td><span className={`badge ${STATUS_MAP[t.status]||'badge-muted'}`}>{t.status||'completed'}</span></td>
                    <td>
                      {(t.status==='completed') && (
                        <div style={{display:'flex',gap:6}}>
                          <button className="btn btn-ghost btn-sm" onClick={()=>setRefundModal({show:true,tx:t})}>Refund</button>
                          <button className="btn btn-ghost btn-sm" style={{color:'var(--red)'}} onClick={()=>voidMut.mutate(t.id)}>Void</button>
                        </div>
                      )}
                      {t.status==='refunded' && <span style={{fontSize:'.75rem',color:'var(--text-3)'}}>−{fmt(t.refund_amount)}</span>}
                    </td>
                  </tr>
                )) : <tr><td colSpan={7} style={{textAlign:'center',color:'var(--text-3)',padding:32}}>No transactions yet.</td></tr>}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ── ITEMS ── */}
      {tab==='items' && (
        <div style={{display:'grid',gap:16}}>
          {/* Add item form */}
          <div className="card">
            <div className="card-header"><span className="card-title">Add Item</span></div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:12,marginTop:12}}>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Icon</div><input className="form-input" value={newItem.icon} onChange={e=>setNewItem(s=>({...s,icon:e.target.value}))} style={{width:'100%'}} /></div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Name</div><input className="form-input" value={newItem.name} onChange={e=>setNewItem(s=>({...s,name:e.target.value}))} style={{width:'100%'}} /></div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Category</div>
                <select className="form-select" value={newItem.category} onChange={e=>setNewItem(s=>({...s,category:e.target.value}))} style={{width:'100%'}}>
                  {CATEGORIES.map(c=><option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Sell Price</div><input className="form-input" type="number" value={newItem.sell_price} onChange={e=>setNewItem(s=>({...s,sell_price:e.target.value}))} style={{width:'100%'}} /></div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Cost Price</div><input className="form-input" type="number" value={newItem.cost_price} onChange={e=>setNewItem(s=>({...s,cost_price:e.target.value}))} style={{width:'100%'}} /></div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Tax Rate %</div><input className="form-input" type="number" value={newItem.tax_rate} onChange={e=>setNewItem(s=>({...s,tax_rate:e.target.value}))} style={{width:'100%'}} /></div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Stock Qty</div><input className="form-input" type="number" value={newItem.stock_qty} onChange={e=>setNewItem(s=>({...s,stock_qty:e.target.value}))} style={{width:'100%'}} /></div>
              <div style={{display:'flex',alignItems:'center',gap:8,paddingTop:20}}>
                <input type="checkbox" id="ce" checked={newItem.charge_eligible} onChange={e=>setNewItem(s=>({...s,charge_eligible:e.target.checked}))} />
                <label htmlFor="ce" style={{fontSize:'.82rem'}}>Charge eligible</label>
              </div>
            </div>
            <button className="btn btn-primary" style={{marginTop:12}} onClick={()=>createItemMut.mutate()} disabled={!newItem.name||!newItem.sell_price}>Add Item</button>
          </div>

          {/* Items table */}
          <div className="card" style={{padding:0}}>
            <table className="data-table">
              <thead><tr><th>Item</th><th>Category</th><th>Cost</th><th>Price</th><th>Tax</th><th>Stock</th><th>⚡ Charge</th><th>Active</th><th></th></tr></thead>
              <tbody>
                {(items as any[]).map((item:any) => (
                  <tr key={item.id}>
                    <td style={{fontWeight:500}}>{item.icon} {item.name}</td>
                    <td><span className="badge badge-muted">{item.category}</span></td>
                    <td className="mono">{fmt(item.cost_price)}</td>
                    <td className="mono" style={{color:'var(--gold)',fontWeight:600}}>{fmt(item.sell_price)}</td>
                    <td className="mono">{pct(item.tax_rate)}</td>
                    <td className="mono">{item.stock_qty >= 999 ? '∞' : item.stock_qty}</td>
                    <td>
                      <button onClick={()=>toggleChargeMut.mutate({id:item.id,val:!item.charge_eligible})}
                        style={{background:item.charge_eligible?'var(--gold-bg)':'var(--bg-3)',border:`1px solid ${item.charge_eligible?'var(--gold)':'var(--border-1)'}`,borderRadius:4,padding:'2px 8px',cursor:'pointer',fontSize:'.75rem',color:item.charge_eligible?'var(--gold)':'var(--text-3)',fontWeight:item.charge_eligible?700:400}}>
                        {item.charge_eligible?'Yes':'No'}
                      </button>
                    </td>
                    <td>
                      <button onClick={()=>toggleActiveMut.mutate({id:item.id,val:!item.is_active})}
                        style={{background:item.is_active?'var(--bg-2)':'var(--bg-3)',border:'1px solid var(--border-1)',borderRadius:4,padding:'2px 8px',cursor:'pointer',fontSize:'.75rem',color:item.is_active?'var(--green)':'var(--text-3)'}}>
                        {item.is_active?'Active':'Off'}
                      </button>
                    </td>
                    <td>
                      <button className="btn btn-ghost btn-sm" onClick={()=>setEditItem({...item, _sell:String(item.sell_price), _cost:String(item.cost_price), _tax:String(Number(item.tax_rate)*100), _stock:String(item.stock_qty), _min:String(item.stock_min), _max:String(item.stock_max)})}>Edit</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── TAX RATES ── */}
      {tab==='taxes' && (
        <div style={{display:'grid',gap:16}}>
          <div className="card">
            <div className="card-header"><span className="card-title">Add Tax Rate</span></div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:12,marginTop:12}}>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Name</div><input className="form-input" placeholder="AZ State Tax" value={newTax.name} onChange={e=>setNewTax(s=>({...s,name:e.target.value}))} style={{width:'100%'}} /></div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Rate %</div><input className="form-input" type="number" placeholder="8.00" value={newTax.rate} onChange={e=>setNewTax(s=>({...s,rate:e.target.value}))} style={{width:'100%'}} /></div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Type</div>
                <select className="form-select" value={newTax.tax_type} onChange={e=>setNewTax(s=>({...s,tax_type:e.target.value}))} style={{width:'100%'}}>
                  {TAX_TYPES.map(t=><option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Applies To</div>
                <select className="form-select" value={newTax.applies_to} onChange={e=>setNewTax(s=>({...s,applies_to:e.target.value}))} style={{width:'100%'}}>
                  <option value="all">All categories</option>
                  {CATEGORIES.map(c=><option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            </div>
            <button className="btn btn-primary" style={{marginTop:12}} onClick={()=>createTaxMut.mutate()} disabled={!newTax.name||!newTax.rate}>Add Rate</button>
          </div>
          <div className="card" style={{padding:0}}>
            <table className="data-table">
              <thead><tr><th>Name</th><th>Type</th><th>Rate</th><th>Applies To</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {(taxRates as any[]).length ? (taxRates as any[]).map((r:any) => (
                  <tr key={r.id}>
                    <td style={{fontWeight:500}}>{r.name}</td>
                    <td><span className="badge badge-muted">{r.tax_type}</span></td>
                    <td className="mono">{pct(r.rate)}</td>
                    <td style={{fontSize:'.82rem'}}>{Array.isArray(r.applies_to)?r.applies_to.join(', '):r.applies_to}</td>
                    <td><span className={`badge ${r.is_active?'badge-green':'badge-red'}`}>{r.is_active?'active':'inactive'}</span></td>
                    <td><button className="btn btn-ghost btn-sm" style={{color:'var(--red)'}} onClick={()=>deleteTaxMut.mutate(r.id)}>Remove</button></td>
                  </tr>
                )) : <tr><td colSpan={6} style={{textAlign:'center',color:'var(--text-3)',padding:32}}>No tax rates configured.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── DISCOUNTS ── */}
      {tab==='discounts' && (
        <div style={{display:'grid',gap:16}}>
          <div className="card">
            <div className="card-header"><span className="card-title">Add Discount</span></div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:12,marginTop:12}}>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Name</div><input className="form-input" placeholder="Senior Discount" value={newDiscount.name} onChange={e=>setNewDiscount(s=>({...s,name:e.target.value}))} style={{width:'100%'}} /></div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Type</div>
                <select className="form-select" value={newDiscount.type} onChange={e=>setNewDiscount(s=>({...s,type:e.target.value}))} style={{width:'100%'}}>
                  <option value="percent">Percent %</option>
                  <option value="fixed">Fixed $</option>
                </select>
              </div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Value</div><input className="form-input" type="number" placeholder={newDiscount.type==='percent'?'10':'5.00'} value={newDiscount.value} onChange={e=>setNewDiscount(s=>({...s,value:e.target.value}))} style={{width:'100%'}} /></div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Code (optional)</div><input className="form-input" placeholder="SENIOR10" value={newDiscount.code} onChange={e=>setNewDiscount(s=>({...s,code:e.target.value}))} style={{width:'100%'}} /></div>
            </div>
            <button className="btn btn-primary" style={{marginTop:12}} onClick={()=>createDiscountMut.mutate()} disabled={!newDiscount.name||!newDiscount.value}>Add Discount</button>
          </div>
          <div className="card" style={{padding:0}}>
            <table className="data-table">
              <thead><tr><th>Name</th><th>Type</th><th>Value</th><th>Code</th><th></th></tr></thead>
              <tbody>
                {(discounts as any[]).length ? (discounts as any[]).map((d:any) => (
                  <tr key={d.id}>
                    <td style={{fontWeight:500}}>{d.name}</td>
                    <td><span className="badge badge-muted">{d.type}</span></td>
                    <td className="mono">{d.type==='percent'?`${d.value}%`:fmt(d.value)}</td>
                    <td className="mono" style={{color:'var(--gold)'}}>{d.code||'—'}</td>
                    <td><button className="btn btn-ghost btn-sm" style={{color:'var(--red)'}} onClick={()=>deleteDiscountMut.mutate(d.id)}>Remove</button></td>
                  </tr>
                )) : <tr><td colSpan={5} style={{textAlign:'center',color:'var(--text-3)',padding:32}}>No discounts configured.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}


      {/* Edit Item Modal */}
      {editItem && (
        <div className="modal-overlay" onClick={()=>setEditItem(null)}>
          <div className="modal" style={{maxWidth:520}} onClick={e=>e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">{editItem.icon} Edit — {editItem.name}</span>
              <button className="btn btn-ghost btn-sm" onClick={()=>setEditItem(null)}>✕</button>
            </div>
            <div style={{padding:'0 24px 24px',display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Name</div>
                <input className="form-input" style={{width:'100%'}} value={editItem.name} onChange={e=>setEditItem((s:any)=>({...s,name:e.target.value}))} /></div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Icon</div>
                <input className="form-input" style={{width:'100%'}} value={editItem.icon} onChange={e=>setEditItem((s:any)=>({...s,icon:e.target.value}))} /></div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Category</div>
                <select className="form-select" style={{width:'100%'}} value={editItem.category} onChange={e=>setEditItem((s:any)=>({...s,category:e.target.value}))}>
                  {CATEGORIES.map(c=><option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Sell Price</div>
                <input className="form-input" style={{width:'100%'}} type="number" value={editItem._sell} onChange={e=>setEditItem((s:any)=>({...s,_sell:e.target.value}))} /></div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Cost Price</div>
                <input className="form-input" style={{width:'100%'}} type="number" value={editItem._cost} onChange={e=>setEditItem((s:any)=>({...s,_cost:e.target.value}))} /></div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Tax Rate %</div>
                <input className="form-input" style={{width:'100%'}} type="number" value={editItem._tax} onChange={e=>setEditItem((s:any)=>({...s,_tax:e.target.value}))} /></div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Stock Qty</div>
                <input className="form-input" style={{width:'100%'}} type="number" value={editItem._stock} onChange={e=>setEditItem((s:any)=>({...s,_stock:e.target.value}))} /></div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Stock Min</div>
                <input className="form-input" style={{width:'100%'}} type="number" value={editItem._min} onChange={e=>setEditItem((s:any)=>({...s,_min:e.target.value}))} /></div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Stock Max</div>
                <input className="form-input" style={{width:'100%'}} type="number" value={editItem._max} onChange={e=>setEditItem((s:any)=>({...s,_max:e.target.value}))} /></div>
              <div style={{display:'flex',alignItems:'center',gap:8,paddingTop:20}}>
                <input type="checkbox" id="ec" checked={editItem.charge_eligible} onChange={e=>setEditItem((s:any)=>({...s,charge_eligible:e.target.checked}))} />
                <label htmlFor="ec" style={{fontSize:'.82rem'}}>Charge eligible</label>
              </div>
              <div style={{gridColumn:'1/-1',marginTop:8}}>
                <button className="btn btn-primary" style={{width:'100%'}} onClick={()=>updateItemMut.mutate({
                  name:editItem.name, icon:editItem.icon, category:editItem.category,
                  sellPrice:Number(editItem._sell), costPrice:Number(editItem._cost),
                  taxRate:Number(editItem._tax)/100, stockQty:Number(editItem._stock),
                  stockMin:Number(editItem._min), stockMax:Number(editItem._max),
                  chargeEligible:editItem.charge_eligible
                })} disabled={updateItemMut.isLoading}>
                  {updateItemMut.isLoading?'Saving…':'Save Changes'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Open Item Modal */}
      {openItem.show && (
        <div className="modal-overlay" onClick={()=>setOpenItem(o=>({...o,show:false}))}>
          <div className="modal" style={{maxWidth:360}} onClick={e=>e.stopPropagation()}>
            <div className="modal-header"><span className="modal-title">Open Item</span><button className="btn btn-ghost btn-sm" onClick={()=>setOpenItem(o=>({...o,show:false}))}>✕</button></div>
            <div style={{padding:'0 24px 24px',display:'grid',gap:12}}>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Description</div><input className="form-input" style={{width:'100%'}} placeholder="Item name" value={openItem.name} onChange={e=>setOpenItem(o=>({...o,name:e.target.value}))} /></div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Price</div><input className="form-input" style={{width:'100%'}} type="number" placeholder="0.00" value={openItem.price} onChange={e=>setOpenItem(o=>({...o,price:e.target.value}))} /></div>
              <button className="btn btn-primary" onClick={addOpenItem} disabled={!openItem.name||!openItem.price}>Add to Cart</button>
            </div>
          </div>
        </div>
      )}

      {/* Refund Modal */}
      {refundModal.show && (
        <div className="modal-overlay" onClick={()=>setRefundModal({show:false,tx:null})}>
          <div className="modal" style={{maxWidth:380}} onClick={e=>e.stopPropagation()}>
            <div className="modal-header"><span className="modal-title">Refund Transaction</span><button className="btn btn-ghost btn-sm" onClick={()=>setRefundModal({show:false,tx:null})}>✕</button></div>
            <div style={{padding:'0 24px 24px',display:'grid',gap:12}}>
              <div style={{fontSize:'.85rem',color:'var(--text-3)'}}>Original total: <strong style={{color:'var(--text-0)'}}>{fmt(refundModal.tx?.total)}</strong></div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Refund Amount (leave blank for full)</div><input className="form-input" style={{width:'100%'}} type="number" placeholder={refundModal.tx?.total} value={refundAmt} onChange={e=>setRefundAmt(e.target.value)} /></div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Reason</div><input className="form-input" style={{width:'100%'}} placeholder="Customer returned item" value={refundReason} onChange={e=>setRefundReason(e.target.value)} /></div>
              <button className="btn btn-primary" onClick={()=>refundMut.mutate()} disabled={refundMut.isLoading}>Process Refund</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
