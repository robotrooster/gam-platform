import { useState } from 'react'
import { discoverReaders, connectReader, collectCardPayment, cancelCurrentPayment } from '../lib/terminal'
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
  const [tab, setTab] = useState<'register'|'history'|'items'|'taxes'|'discounts'|'vendors'|'orders'|'inventory'>('register')

  const [cart, setCart] = useState<CartItem[]>([])
  const [method, setMethod] = useState<'cash'|'card'|'charge'>('cash')
  const [tenantId, setTenantId] = useState('')
  const [cashGiven, setCashGiven] = useState('')
  const [filterCat, setFilterCat] = useState('all')
  const [receipt, setReceipt] = useState<any>(null)
  const [appliedDiscount, setAppliedDiscount] = useState<any>(null)
  const [discountCode, setDiscountCode] = useState('')
  const [openItem, setOpenItem] = useState({ name:'', price:'', show:false })
  const [refundModal, setRefundModal] = useState<{show:boolean; tx:any}>({show:false,tx:null})
  const [refundAmt, setRefundAmt] = useState('')
  const [refundReason, setRefundReason] = useState('')
  const [readerModal, setReaderModal] = useState(false)
  const [readers, setReaders] = useState<any[]>([])
  const [connectedReader, setConnectedReader] = useState<any>(null)
  const [terminalStatus, setTerminalStatus] = useState<'idle'|'discovering'|'connecting'|'collecting'|'error'>('idle')
  const [terminalError, setTerminalError] = useState('')
  const [editItem, setEditItem] = useState<any>(null)
  const [newItem, setNewItem] = useState({ name:'', category:'misc', icon:'📦', sellPrice:'', costPrice:'', taxRate:'0', chargeEligible:true, stockQty:'0', stockMin:'5', stockMax:'50' })
  const [newTax, setNewTax] = useState({ name:'', rate:'', taxType:'state', appliesTo:'all' })
  const [newDiscount, setNewDiscount] = useState({ name:'', type:'percent', value:'', code:'' })
  const [newVendor, setNewVendor] = useState({ name:'', contactName:'', email:'', phone:'', address:'', leadTimeDays:'3', notes:'' })
  const [editVendor, setEditVendor] = useState<any>(null)
  const [newPO, setNewPO] = useState({ vendorId:'', notes:'', expectedDate:'' })
  const [poItems, setPoItems] = useState<{itemId:string;itemName:string;qtyOrdered:number;unitCost:number}[]>([])
  const [poItemRow, setPoItemRow] = useState({ itemId:'', qtyOrdered:'1', unitCost:'' })
  const [expandedPO, setExpandedPO] = useState<string|null>(null)

  const { data: items = [] } = useQuery<any[]>('pos-items', () => apiGet('/pos/items'))
  const { data: tenants = [] } = useQuery<any[]>('tenants', () => apiGet('/tenants'))
  const { data: taxRates = [] } = useQuery<any[]>('pos-tax-rates', () => apiGet('/pos/tax-rates'), { enabled: tab==='taxes'||tab==='register' })
  const { data: discounts = [] } = useQuery<any[]>('pos-discounts', () => apiGet('/pos/discounts'), { enabled: tab==='discounts'||tab==='register' })
  const { data: txns = [], isLoading: txLoading } = useQuery<any[]>('pos-transactions', () => apiGet('/pos/transactions'), { enabled: tab==='history' })
  const { data: vendors = [] } = useQuery<any[]>('pos-vendors', () => apiGet('/pos/vendors'), { enabled: tab==='vendors'||tab==='orders' })
  const { data: purchaseOrders = [] } = useQuery<any[]>('pos-purchase-orders', () => apiGet('/pos/purchase-orders'), { enabled: tab==='orders' })
  const { data: inventoryLog = [] } = useQuery<any[]>('pos-inventory-log', () => apiGet('/pos/inventory-log'), { enabled: tab==='inventory' })
  const { data: lowStock = [] } = useQuery<any[]>('pos-low-stock', () => apiGet('/pos/low-stock'), { enabled: tab==='inventory' })

  const categories = ['all', ...Array.from(new Set((items as any[]).map((i:any) => i.category)))]
  const visibleItems = filterCat === 'all' ? (items as any[]) : (items as any[]).filter((i:any) => i.category === filterCat)

  const addToCart = (item: any) => {
    setCart(c => {
      const ex = c.find(x => x.id === item.id)
      if (ex) return c.map(x => x.id===item.id ? {...x,qty:x.qty+1} : x)
      return [...c, { id:item.id, name:item.name, price:Number(item.sellPrice), qty:1, tax:Number(item.taxRate), cat:item.category, icon:item.icon, chargeEligible:item.chargeEligible }]
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

  const applyDiscountCode = () => {
    const d = (discounts as any[]).find((x:any) => x.code?.toLowerCase() === discountCode.toLowerCase())
    if (d) { setAppliedDiscount(d); setDiscountCode('') }
  }

  const checkoutMut = useMutation(
    () => apiPost('/pos/transactions', {
      items: cart.map(i => ({ id:i.id.startsWith('open-')?null:i.id, name:i.name, qty:i.qty, price:i.price, tax:i.tax, cat:i.cat })),
      paymentMethod:method, tenantId:tenantId||null,
      subtotal:discountedSubtotal, taxAmount, surcharge, total, changeGiven:changeDue,
      discountAmount:discountAmt, discountReason:appliedDiscount?.name||null
    }),
    { onSuccess: (res:any) => {
      setReceipt({ ...res.data, cartItems:cart, subtotal, discountAmt, taxAmount, surcharge, total, changeDue, method })
      setCart([]); setCashGiven(''); setTenantId(''); setAppliedDiscount(null)
      qc.invalidateQueries('pos-transactions'); qc.invalidateQueries('pos-items')
    }}
  )

  const toggleChargeMut = useMutation(({ id, val }:{ id:string; val:boolean }) => apiPatch(`/pos/items/${id}`, { chargeEligible:val }), { onSuccess: () => qc.invalidateQueries('pos-items') })
  const toggleActiveMut = useMutation(({ id, val }:{ id:string; val:boolean }) => apiPatch(`/pos/items/${id}`, { isActive:val }), { onSuccess: () => qc.invalidateQueries('pos-items') })
  const createItemMut = useMutation(() => apiPost('/pos/items', { ...newItem, costPrice:Number(newItem.costPrice), sellPrice:Number(newItem.sellPrice), taxRate:Number(newItem.taxRate), chargeEligible:newItem.chargeEligible, stockQty:Number(newItem.stockQty), stockMin:Number(newItem.stockMin), stockMax:Number(newItem.stockMax) }), { onSuccess: () => { qc.invalidateQueries('pos-items'); setNewItem({ name:'', category:'misc', icon:'📦', sellPrice:'', costPrice:'', taxRate:'0', chargeEligible:true, stockQty:'0', stockMin:'5', stockMax:'50' }) } })
  const updateItemMut = useMutation((data:any) => apiPatch(`/pos/items/${editItem.id}`, data), { onSuccess: () => { qc.invalidateQueries('pos-items'); setEditItem(null) } })

  const createVendorMut = useMutation(() => apiPost('/pos/vendors', { ...newVendor, leadTimeDays:Number(newVendor.leadTimeDays) }), { onSuccess: () => { qc.invalidateQueries('pos-vendors'); setNewVendor({ name:'', contactName:'', email:'', phone:'', address:'', leadTimeDays:'3', notes:'' }) } })
  const updateVendorMut = useMutation((data:any) => apiPatch(`/pos/vendors/${editVendor.id}`, data), { onSuccess: () => { qc.invalidateQueries('pos-vendors'); setEditVendor(null) } })

  const createPOMut = useMutation(() => apiPost('/pos/purchase-orders', { ...newPO, items: poItems }), { onSuccess: () => { qc.invalidateQueries('pos-purchase-orders'); setNewPO({ vendorId:'', notes:'', expectedDate:'' }); setPoItems([]) } })
  const updatePOMut = useMutation(({ id, status }:{ id:string; status:string }) => apiPatch(`/pos/purchase-orders/${id}`, { status }), { onSuccess: () => qc.invalidateQueries('pos-purchase-orders') })

  const createTaxMut = useMutation(() => apiPost('/pos/tax-rates', { ...newTax, rate:Number(newTax.rate)/100, taxType:newTax.taxType, appliesTo:newTax.appliesTo==='all'?['all']:[newTax.appliesTo] }), { onSuccess: () => { qc.invalidateQueries('pos-tax-rates'); setNewTax({ name:'', rate:'', taxType:'state', appliesTo:'all' }) } })
  const deleteTaxMut = useMutation((id:string) => apiDel(`/pos/tax-rates/${id}`), { onSuccess: () => qc.invalidateQueries('pos-tax-rates') })
  const createDiscountMut = useMutation(() => apiPost('/pos/discounts', { ...newDiscount, value:Number(newDiscount.value) }), { onSuccess: () => { qc.invalidateQueries('pos-discounts'); setNewDiscount({ name:'', type:'percent', value:'', code:'' }) } })
  const deleteDiscountMut = useMutation((id:string) => apiDel(`/pos/discounts/${id}`), { onSuccess: () => qc.invalidateQueries('pos-discounts') })
  const refundMut = useMutation(() => apiPost(`/pos/transactions/${refundModal.tx?.id}/refund`, { amount:Number(refundAmt)||refundModal.tx?.total, reason:refundReason, refundMethod:refundModal.tx?.paymentMethod }), { onSuccess: () => { qc.invalidateQueries('pos-transactions'); setRefundModal({show:false,tx:null}); setRefundAmt(''); setRefundReason('') } })
  const voidMut = useMutation((id:string) => apiPost(`/pos/transactions/${id}/void`, { reason:'Voided by cashier' }), { onSuccess: () => qc.invalidateQueries('pos-transactions') })

  const discoverAndConnect = async () => {
    setTerminalStatus('discovering'); setTerminalError('')
    try { const found = await discoverReaders(); setReaders(found); setTerminalStatus('idle') }
    catch (e: any) { setTerminalError(e.message); setTerminalStatus('error') }
  }
  const connectToReader = async (reader: any) => {
    setTerminalStatus('connecting')
    try { const r = await connectReader(reader); setConnectedReader(r); setReaderModal(false); setTerminalStatus('idle') }
    catch (e: any) { setTerminalError(e.message); setTerminalStatus('error') }
  }
  const chargeWithReader = async () => {
    if (!connectedReader) { setReaderModal(true); discoverAndConnect(); return }
    setTerminalStatus('collecting')
    try {
      const res = await fetch((import.meta as any).env?.VITE_API_URL + '/api/terminal/create-payment-intent', {
        method:'POST', headers:{'Content-Type':'application/json', Authorization:'Bearer '+localStorage.getItem('gam_token')},
        body: JSON.stringify({ amount:total, description:'GAM POS Sale' })
      }).then(r => r.json())
      await collectCardPayment(res.data.clientSecret)
      setTerminalStatus('idle'); checkoutMut.mutate()
    } catch (e: any) { setTerminalError(e.message); setTerminalStatus('error'); await cancelCurrentPayment().catch(()=>{}) }
  }

  const TABS = [
    { key:'register',  label:'Register' },
    { key:'history',   label:'History' },
    { key:'items',     label:'Items' },
    { key:'taxes',     label:'Tax Rates' },
    { key:'discounts', label:'Discounts' },
    { key:'vendors',   label:'Vendors' },
    { key:'orders',    label:'Orders' },
    { key:'inventory', label:'Inventory' },
  ]

  if (receipt) return (
    <div>
      <div className="page-header"><div><h1 className="page-title">Point of Sale</h1></div></div>
      <div style={{maxWidth:420,margin:'0 auto'}}>
        <div className="card" style={{textAlign:'center',padding:32}}>
          <div style={{fontSize:'2rem',marginBottom:8}}>✅</div>
          <div style={{fontWeight:700,fontSize:'1.1rem',marginBottom:4}}>Sale Complete</div>
          <div style={{color:'var(--text-3)',fontSize:'.82rem',marginBottom:24}}>Transaction recorded</div>
          <table className="data-table" style={{marginBottom:16}}>
            <tbody>{receipt.cartItems.map((i:any,idx:number) => (<tr key={idx}><td>{i.icon} {i.name}</td><td className="mono">x{i.qty}</td><td className="mono">{fmt(i.price*i.qty)}</td></tr>))}</tbody>
          </table>
          <div style={{display:'grid',gap:4,fontSize:'.88rem',marginBottom:16}}>
            <div style={{display:'flex',justifyContent:'space-between'}}><span style={{color:'var(--text-3)'}}>Subtotal</span><span>{fmt(receipt.subtotal)}</span></div>
            {receipt.discountAmt>0&&<div style={{display:'flex',justifyContent:'space-between',color:'var(--green)'}}><span>Discount</span><span>-{fmt(receipt.discountAmt)}</span></div>}
            {receipt.taxAmount>0&&<div style={{display:'flex',justifyContent:'space-between'}}><span style={{color:'var(--text-3)'}}>Tax</span><span>{fmt(receipt.taxAmount)}</span></div>}
            {receipt.surcharge>0&&<div style={{display:'flex',justifyContent:'space-between'}}><span style={{color:'var(--text-3)'}}>FlexCharge fee</span><span>{fmt(receipt.surcharge)}</span></div>}
            <div style={{display:'flex',justifyContent:'space-between',fontWeight:700,fontSize:'1rem',borderTop:'1px solid var(--border-1)',paddingTop:8,marginTop:4}}>
              <span>Total</span><span style={{color:'var(--gold)'}}>{fmt(receipt.total)}</span>
            </div>
            {receipt.method==='cash'&&receipt.changeDue>0&&<div style={{display:'flex',justifyContent:'space-between',color:'var(--green)',fontWeight:600}}><span>Change Due</span><span>{fmt(receipt.changeDue)}</span></div>}
          </div>
          <button className="btn btn-primary" style={{width:'100%'}} onClick={()=>setReceipt(null)}>New Sale</button>
        </div>
      </div>
    </div>
  )

  return (
    <div>
      <div className="page-header">
        <div><h1 className="page-title">Point of Sale</h1><p className="page-subtitle">Register · Vendors · Orders · Inventory</p></div>
        <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
          {TABS.map(t => <button key={t.key} className={"tab-btn "+(tab===t.key?'active':'')} onClick={()=>setTab(t.key as any)}>{t.label}</button>)}
        </div>
      </div>

      {tab==='register' && (
        <div style={{display:'grid',gridTemplateColumns:'1fr 340px',gap:16,alignItems:'start'}}>
          <div>
            <div style={{display:'flex',gap:6,marginBottom:12,flexWrap:'wrap'}}>
              {categories.map(c => (<button key={c} onClick={()=>setFilterCat(c)} className={"tab-btn "+(filterCat===c?'active':'')} style={{fontSize:'.78rem',padding:'4px 12px',textTransform:'capitalize'}}>{c}</button>))}
              <button onClick={()=>setOpenItem(o=>({...o,show:true}))} className="tab-btn" style={{fontSize:'.78rem',padding:'4px 12px',marginLeft:'auto'}}>+ Open Item</button>
            </div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(130px,1fr))',gap:10}}>
              {visibleItems.filter((i:any)=>i.isActive).map((item:any) => (
                <button key={item.id} onClick={()=>addToCart(item)} style={{background:'var(--bg-2)',border:'1px solid var(--border-1)',borderRadius:'var(--r-lg)',padding:16,cursor:'pointer',textAlign:'left'}} onMouseEnter={e=>(e.currentTarget.style.borderColor='var(--gold)')} onMouseLeave={e=>(e.currentTarget.style.borderColor='var(--border-1)')}>
                  <div style={{fontSize:'1.4rem',marginBottom:6}}>{item.icon}</div>
                  <div style={{fontSize:'.82rem',fontWeight:600,color:'var(--text-0)',marginBottom:2}}>{item.name}</div>
                  <div style={{fontSize:'.88rem',color:'var(--gold)',fontWeight:700}}>{fmt(item.sellPrice)}</div>
                  <div style={{display:'flex',gap:4,marginTop:4,flexWrap:'wrap'}}>
                    {item.chargeEligible&&<span style={{fontSize:'.65rem',background:'var(--gold-bg)',color:'var(--gold)',padding:'1px 4px',borderRadius:3}}>charge</span>}
                    {item.stockQty<999&&<span style={{fontSize:'.65rem',color:item.stockQty<=item.stockMin?'var(--amber)':'var(--text-3)'}}>{item.stockQty} left</span>}
                  </div>
                </button>
              ))}
            </div>
          </div>
          <div className="card" style={{position:'sticky',top:80}}>
            <div className="card-header"><span className="card-title">Current Sale</span>
              {cart.length>0&&<button onClick={()=>setCart([])} style={{background:'none',border:'none',color:'var(--text-3)',cursor:'pointer',fontSize:'.75rem'}}>Clear</button>}
            </div>
            {cart.length===0?(<div style={{color:'var(--text-3)',fontSize:'.85rem',padding:'24px 0',textAlign:'center'}}>No items added</div>):(
              <div style={{marginBottom:12}}>
                {cart.map(i=>(<div key={i.id} style={{display:'flex',alignItems:'center',gap:6,padding:'7px 0',borderBottom:'1px solid var(--border-1)'}}>
                  <span>{i.icon}</span>
                  <div style={{flex:1,minWidth:0}}><div style={{fontSize:'.8rem',fontWeight:500,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{i.name}</div>
                    {!i.chargeEligible&&method==='charge'&&<div style={{fontSize:'.65rem',color:'var(--red)'}}>not charge eligible</div>}
                  </div>
                  <div style={{display:'flex',alignItems:'center',gap:4}}>
                    <button onClick={()=>updateQty(i.id,-1)} style={{background:'var(--bg-3)',border:'none',borderRadius:3,width:20,height:20,cursor:'pointer',fontWeight:700}}>-</button>
                    <span style={{fontSize:'.82rem',fontWeight:600,minWidth:14,textAlign:'center'}}>{i.qty}</span>
                    <button onClick={()=>updateQty(i.id,1)} style={{background:'var(--bg-3)',border:'none',borderRadius:3,width:20,height:20,cursor:'pointer',fontWeight:700}}>+</button>
                  </div>
                  <div style={{fontSize:'.82rem',fontWeight:600,minWidth:44,textAlign:'right'}}>{fmt(i.price*i.qty)}</div>
                </div>))}
              </div>
            )}
            {appliedDiscount?(<div style={{display:'flex',justifyContent:'space-between',alignItems:'center',background:'var(--gold-bg)',borderRadius:6,padding:'6px 10px',marginBottom:10,fontSize:'.8rem'}}>
              <span style={{color:'var(--gold)',fontWeight:600}}>discount: {appliedDiscount.name}</span>
              <button onClick={()=>setAppliedDiscount(null)} style={{background:'none',border:'none',cursor:'pointer',color:'var(--text-3)'}}>x</button>
            </div>):(<div style={{display:'flex',gap:6,marginBottom:10}}>
              <input className="form-input" placeholder="Discount code" value={discountCode} onChange={e=>setDiscountCode(e.target.value)} style={{flex:1,fontSize:'.78rem',padding:'4px 8px'}} />
              <button className="btn btn-ghost btn-sm" onClick={applyDiscountCode}>Apply</button>
            </div>)}
            <div style={{fontSize:'.82rem',display:'grid',gap:3,marginBottom:12}}>
              <div style={{display:'flex',justifyContent:'space-between'}}><span style={{color:'var(--text-3)'}}>Subtotal</span><span>{fmt(subtotal)}</span></div>
              {discountAmt>0&&<div style={{display:'flex',justifyContent:'space-between',color:'var(--green)'}}><span>Discount</span><span>-{fmt(discountAmt)}</span></div>}
              {taxAmount>0&&<div style={{display:'flex',justifyContent:'space-between'}}><span style={{color:'var(--text-3)'}}>Tax</span><span>{fmt(taxAmount)}</span></div>}
              {surcharge>0&&<div style={{display:'flex',justifyContent:'space-between'}}><span style={{color:'var(--text-3)'}}>FlexCharge (1%)</span><span>{fmt(surcharge)}</span></div>}
              <div style={{display:'flex',justifyContent:'space-between',fontWeight:700,fontSize:'.95rem',borderTop:'1px solid var(--border-1)',paddingTop:6,marginTop:2}}>
                <span>Total</span><span style={{color:'var(--gold)'}}>{fmt(total)}</span>
              </div>
            </div>
            <div style={{marginBottom:10}}>
              <div style={{fontSize:'.72rem',color:'var(--text-3)',marginBottom:5}}>Payment method</div>
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:5}}>
                {(['cash','card','charge'] as const).map(m=>(<button key={m} onClick={()=>setMethod(m)} style={{padding:'7px 0',border:"1px solid "+(method===m?'var(--gold)':'var(--border-1)'),background:method===m?'var(--gold-bg)':'var(--bg-2)',borderRadius:'var(--r-md)',cursor:'pointer',fontSize:'.75rem',fontWeight:method===m?700:400,color:method===m?'var(--gold)':'var(--text-2)',textTransform:'capitalize'}}>{m==='charge'?'charge':m}</button>))}
              </div>
            </div>
            {method==='cash'&&(<div style={{marginBottom:10}}>
              <input className="form-input" type="number" placeholder="Cash given" value={cashGiven} onChange={e=>setCashGiven(e.target.value)} style={{width:'100%'}} />
              {cashGiven&&Number(cashGiven)>=total&&<div style={{fontSize:'.82rem',color:'var(--green)',fontWeight:600,marginTop:4}}>Change: {fmt(changeDue)}</div>}
            </div>)}
            {method==='charge'&&(<div style={{marginBottom:10}}>
              <select className="form-select" value={tenantId} onChange={e=>setTenantId(e.target.value)} style={{width:'100%'}}>
                <option value="">Select tenant...</option>
                {(tenants as any[]).map((t:any)=><option key={t.id} value={t.id}>{t.firstName} {t.lastName}</option>)}
              </select>
              {chargeBlocked&&<div style={{fontSize:'.72rem',color:'var(--red)',marginTop:4}}>Cart has non-charge-eligible items</div>}
            </div>)}
            <button className="btn btn-primary" style={{width:'100%'}} disabled={cart.length===0||checkoutMut.isLoading||(method==='charge'&&(!tenantId||chargeBlocked))} onClick={()=>method==='card'?chargeWithReader():checkoutMut.mutate()}>
              {checkoutMut.isLoading?'Processing...':'Charge '+fmt(total)}
            </button>
          </div>
        </div>
      )}

      {tab==='history' && (
        <div className="card" style={{padding:0}}>
          {txLoading?<div style={{padding:32,textAlign:'center',color:'var(--text-3)'}}>Loading...</div>:(
            <table className="data-table">
              <thead><tr><th>Date</th><th>Items</th><th>Subtotal</th><th>Total</th><th>Method</th><th>Status</th><th>Actions</th></tr></thead>
              <tbody>
                {(txns as any[]).length?(txns as any[]).map((t:any)=>(<tr key={t.id}>
                  <td className="mono">{new Date(t.createdAt).toLocaleDateString()}</td>
                  <td style={{color:'var(--text-3)',fontSize:'.82rem'}}>{t.itemCount} items</td>
                  <td className="mono">{fmt(t.subtotal)}</td>
                  <td className="mono" style={{fontWeight:600}}>{fmt(t.total)}</td>
                  <td><span className={"badge "+(METHOD_MAP[t.paymentMethod]||'badge-muted')}>{t.paymentMethod}</span></td>
                  <td><span className={"badge "+(STATUS_MAP[t.status]||'badge-muted')}>{t.status||'completed'}</span></td>
                  <td>{t.status==='completed'&&(<div style={{display:'flex',gap:6}}>
                    <button className="btn btn-ghost btn-sm" onClick={()=>setRefundModal({show:true,tx:t})}>Refund</button>
                    <button className="btn btn-ghost btn-sm" style={{color:'var(--red)'}} onClick={()=>voidMut.mutate(t.id)}>Void</button>
                  </div>)}
                  {t.status==='refunded'&&<span style={{fontSize:'.75rem',color:'var(--text-3)'}}>-{fmt(t.refundAmount)}</span>}
                  </td>
                </tr>)):<tr><td colSpan={7} style={{textAlign:'center',color:'var(--text-3)',padding:32}}>No transactions yet.</td></tr>}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab==='items' && (
        <div style={{display:'grid',gap:16}}>
          <div className="card">
            <div className="card-header"><span className="card-title">Add Item</span></div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:12,marginTop:12}}>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Icon</div><input className="form-input" value={newItem.icon} onChange={e=>setNewItem(s=>({...s,icon:e.target.value}))} style={{width:'100%'}} /></div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Name</div><input className="form-input" value={newItem.name} onChange={e=>setNewItem(s=>({...s,name:e.target.value}))} style={{width:'100%'}} /></div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Category</div><select className="form-select" value={newItem.category} onChange={e=>setNewItem(s=>({...s,category:e.target.value}))} style={{width:'100%'}}>{CATEGORIES.map(c=><option key={c} value={c}>{c}</option>)}</select></div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Sell Price</div><input className="form-input" type="number" value={newItem.sellPrice} onChange={e=>setNewItem(s=>({...s,sellPrice:e.target.value}))} style={{width:'100%'}} /></div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Cost Price</div><input className="form-input" type="number" value={newItem.costPrice} onChange={e=>setNewItem(s=>({...s,costPrice:e.target.value}))} style={{width:'100%'}} /></div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Tax Rate %</div><input className="form-input" type="number" value={newItem.taxRate} onChange={e=>setNewItem(s=>({...s,taxRate:e.target.value}))} style={{width:'100%'}} /></div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Stock Qty</div><input className="form-input" type="number" value={newItem.stockQty} onChange={e=>setNewItem(s=>({...s,stockQty:e.target.value}))} style={{width:'100%'}} /></div>
              <div style={{display:'flex',alignItems:'center',gap:8,paddingTop:20}}><input type="checkbox" id="ce" checked={newItem.chargeEligible} onChange={e=>setNewItem(s=>({...s,chargeEligible:e.target.checked}))} /><label htmlFor="ce" style={{fontSize:'.82rem'}}>Charge eligible</label></div>
            </div>
            <button className="btn btn-primary" style={{marginTop:12}} onClick={()=>createItemMut.mutate()} disabled={!newItem.name||!newItem.sellPrice}>Add Item</button>
          </div>
          <div className="card" style={{padding:0}}>
            <table className="data-table">
              <thead><tr><th>Item</th><th>Category</th><th>Cost</th><th>Price</th><th>Tax</th><th>Stock</th><th>Charge</th><th>Active</th><th></th></tr></thead>
              <tbody>
                {(items as any[]).map((item:any)=>(<tr key={item.id}>
                  <td style={{fontWeight:500}}>{item.icon} {item.name}</td>
                  <td><span className="badge badge-muted">{item.category}</span></td>
                  <td className="mono">{fmt(item.costPrice)}</td>
                  <td className="mono" style={{color:'var(--gold)',fontWeight:600}}>{fmt(item.sellPrice)}</td>
                  <td className="mono">{pct(item.taxRate)}</td>
                  <td className="mono">{item.stockQty>=999?'inf':item.stockQty}</td>
                  <td><button onClick={()=>toggleChargeMut.mutate({id:item.id,val:!item.chargeEligible})} style={{background:item.chargeEligible?'var(--gold-bg)':'var(--bg-3)',border:"1px solid "+(item.chargeEligible?'var(--gold)':'var(--border-1)'),borderRadius:4,padding:'2px 8px',cursor:'pointer',fontSize:'.75rem',color:item.chargeEligible?'var(--gold)':'var(--text-3)'}}>{item.chargeEligible?'Yes':'No'}</button></td>
                  <td><button onClick={()=>toggleActiveMut.mutate({id:item.id,val:!item.isActive})} style={{background:'var(--bg-2)',border:'1px solid var(--border-1)',borderRadius:4,padding:'2px 8px',cursor:'pointer',fontSize:'.75rem',color:item.isActive?'var(--green)':'var(--text-3)'}}>{item.isActive?'Active':'Off'}</button></td>
                  <td><button className="btn btn-ghost btn-sm" onClick={()=>setEditItem({...item,_sell:String(item.sellPrice),_cost:String(item.costPrice),_tax:String(Number(item.taxRate)*100),_stock:String(item.stockQty),_min:String(item.stockMin),_max:String(item.stockMax)})}>Edit</button></td>
                </tr>))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab==='taxes' && (
        <div style={{display:'grid',gap:16}}>
          <div className="card">
            <div className="card-header"><span className="card-title">Add Tax Rate</span></div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:12,marginTop:12}}>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Name</div><input className="form-input" placeholder="AZ State Tax" value={newTax.name} onChange={e=>setNewTax(s=>({...s,name:e.target.value}))} style={{width:'100%'}} /></div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Rate %</div><input className="form-input" type="number" value={newTax.rate} onChange={e=>setNewTax(s=>({...s,rate:e.target.value}))} style={{width:'100%'}} /></div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Type</div><select className="form-select" value={newTax.taxType} onChange={e=>setNewTax(s=>({...s,taxType:e.target.value}))} style={{width:'100%'}}>{TAX_TYPES.map(t=><option key={t} value={t}>{t}</option>)}</select></div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Applies To</div><select className="form-select" value={newTax.appliesTo} onChange={e=>setNewTax(s=>({...s,appliesTo:e.target.value}))} style={{width:'100%'}}><option value="all">All categories</option>{CATEGORIES.map(c=><option key={c} value={c}>{c}</option>)}</select></div>
            </div>
            <button className="btn btn-primary" style={{marginTop:12}} onClick={()=>createTaxMut.mutate()} disabled={!newTax.name||!newTax.rate}>Add Rate</button>
          </div>
          <div className="card" style={{padding:0}}>
            <table className="data-table">
              <thead><tr><th>Name</th><th>Type</th><th>Rate</th><th>Applies To</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {(taxRates as any[]).length?(taxRates as any[]).map((r:any)=>(<tr key={r.id}>
                  <td style={{fontWeight:500}}>{r.name}</td><td><span className="badge badge-muted">{r.taxType}</span></td>
                  <td className="mono">{pct(r.rate)}</td>
                  <td style={{fontSize:'.82rem'}}>{Array.isArray(r.appliesTo)?r.appliesTo.join(', '):r.appliesTo}</td>
                  <td><span className={"badge "+(r.isActive?'badge-green':'badge-red')}>{r.isActive?'active':'inactive'}</span></td>
                  <td><button className="btn btn-ghost btn-sm" style={{color:'var(--red)'}} onClick={()=>deleteTaxMut.mutate(r.id)}>Remove</button></td>
                </tr>)):<tr><td colSpan={6} style={{textAlign:'center',color:'var(--text-3)',padding:32}}>No tax rates configured.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab==='discounts' && (
        <div style={{display:'grid',gap:16}}>
          <div className="card">
            <div className="card-header"><span className="card-title">Add Discount</span></div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:12,marginTop:12}}>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Name</div><input className="form-input" placeholder="Senior Discount" value={newDiscount.name} onChange={e=>setNewDiscount(s=>({...s,name:e.target.value}))} style={{width:'100%'}} /></div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Type</div><select className="form-select" value={newDiscount.type} onChange={e=>setNewDiscount(s=>({...s,type:e.target.value}))} style={{width:'100%'}}><option value="percent">Percent %</option><option value="fixed">Fixed $</option></select></div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Value</div><input className="form-input" type="number" value={newDiscount.value} onChange={e=>setNewDiscount(s=>({...s,value:e.target.value}))} style={{width:'100%'}} /></div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Code (optional)</div><input className="form-input" placeholder="SENIOR10" value={newDiscount.code} onChange={e=>setNewDiscount(s=>({...s,code:e.target.value}))} style={{width:'100%'}} /></div>
            </div>
            <button className="btn btn-primary" style={{marginTop:12}} onClick={()=>createDiscountMut.mutate()} disabled={!newDiscount.name||!newDiscount.value}>Add Discount</button>
          </div>
          <div className="card" style={{padding:0}}>
            <table className="data-table">
              <thead><tr><th>Name</th><th>Type</th><th>Value</th><th>Code</th><th></th></tr></thead>
              <tbody>
                {(discounts as any[]).length?(discounts as any[]).map((d:any)=>(<tr key={d.id}>
                  <td style={{fontWeight:500}}>{d.name}</td><td><span className="badge badge-muted">{d.type}</span></td>
                  <td className="mono">{d.type==='percent'?d.value+"%":fmt(d.value)}</td>
                  <td className="mono" style={{color:'var(--gold)'}}>{d.code||'—'}</td>
                  <td><button className="btn btn-ghost btn-sm" style={{color:'var(--red)'}} onClick={()=>deleteDiscountMut.mutate(d.id)}>Remove</button></td>
                </tr>)):<tr><td colSpan={5} style={{textAlign:'center',color:'var(--text-3)',padding:32}}>No discounts configured.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab==='vendors' && (
        <div style={{display:'grid',gap:16}}>
          <div className="card">
            <div className="card-header"><span className="card-title">Add Vendor</span></div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:12,marginTop:12}}>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Name *</div><input className="form-input" style={{width:'100%'}} placeholder="Acme Supply Co." value={newVendor.name} onChange={e=>setNewVendor(s=>({...s,name:e.target.value}))} /></div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Contact Name</div><input className="form-input" style={{width:'100%'}} placeholder="Jane Smith" value={newVendor.contactName} onChange={e=>setNewVendor(s=>({...s,contactName:e.target.value}))} /></div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Email</div><input className="form-input" style={{width:'100%'}} placeholder="orders@vendor.com" value={newVendor.email} onChange={e=>setNewVendor(s=>({...s,email:e.target.value}))} /></div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Phone</div><input className="form-input" style={{width:'100%'}} placeholder="(555) 000-0000" value={newVendor.phone} onChange={e=>setNewVendor(s=>({...s,phone:e.target.value}))} /></div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Address</div><input className="form-input" style={{width:'100%'}} placeholder="123 Main St" value={newVendor.address} onChange={e=>setNewVendor(s=>({...s,address:e.target.value}))} /></div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Lead Time (days)</div><input className="form-input" type="number" style={{width:'100%'}} value={newVendor.leadTimeDays} onChange={e=>setNewVendor(s=>({...s,leadTimeDays:e.target.value}))} /></div>
              <div style={{gridColumn:'1/-1'}}><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Notes</div><input className="form-input" style={{width:'100%'}} placeholder="Optional notes" value={newVendor.notes} onChange={e=>setNewVendor(s=>({...s,notes:e.target.value}))} /></div>
            </div>
            <button className="btn btn-primary" style={{marginTop:12}} onClick={()=>createVendorMut.mutate()} disabled={!newVendor.name||createVendorMut.isLoading}>Add Vendor</button>
          </div>
          <div className="card" style={{padding:0}}>
            <table className="data-table">
              <thead><tr><th>Name</th><th>Contact</th><th>Email</th><th>Phone</th><th>Lead Time</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {(vendors as any[]).length?(vendors as any[]).map((v:any)=>(<tr key={v.id}>
                  <td style={{fontWeight:600}}>{v.name}</td>
                  <td>{v.contactName||'—'}</td>
                  <td style={{fontSize:'.82rem'}}>{v.email||'—'}</td>
                  <td style={{fontSize:'.82rem'}}>{v.phone||'—'}</td>
                  <td className="mono">{v.leadTimeDays}d</td>
                  <td><span className={"badge "+(v.isActive?'badge-green':'badge-red')}>{v.isActive?'active':'inactive'}</span></td>
                  <td><button className="btn btn-ghost btn-sm" onClick={()=>setEditVendor({...v})}>Edit</button></td>
                </tr>)):<tr><td colSpan={7} style={{textAlign:'center',color:'var(--text-3)',padding:32}}>No vendors yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab==='orders' && (
        <div style={{display:'grid',gap:16}}>
          <div className="card">
            <div className="card-header"><span className="card-title">New Purchase Order</span></div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:12,marginTop:12}}>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Vendor *</div>
                <select className="form-select" style={{width:'100%'}} value={newPO.vendorId} onChange={e=>setNewPO(s=>({...s,vendorId:e.target.value}))}>
                  <option value="">Select vendor...</option>
                  {(vendors as any[]).map((v:any)=><option key={v.id} value={v.id}>{v.name}</option>)}
                </select>
              </div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Expected Date</div><input className="form-input" type="date" style={{width:'100%'}} value={newPO.expectedDate} onChange={e=>setNewPO(s=>({...s,expectedDate:e.target.value}))} /></div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Notes</div><input className="form-input" style={{width:'100%'}} value={newPO.notes} onChange={e=>setNewPO(s=>({...s,notes:e.target.value}))} /></div>
            </div>
            <div style={{marginTop:16,borderTop:'1px solid var(--border-1)',paddingTop:16}}>
              <div style={{fontSize:'.82rem',fontWeight:600,marginBottom:8}}>Line Items</div>
              <div style={{display:'grid',gridTemplateColumns:'2fr 1fr 1fr auto',gap:8,alignItems:'end',marginBottom:8}}>
                <div><div style={{fontSize:'.72rem',color:'var(--text-3)',marginBottom:3}}>Item</div>
                  <select className="form-select" style={{width:'100%'}} value={poItemRow.itemId} onChange={e=>{const it=(items as any[]).find((x:any)=>x.id===e.target.value);setPoItemRow(s=>({...s,itemId:e.target.value,unitCost:it?String(it.costPrice):s.unitCost}))}}>
                    <option value="">Select item...</option>
                    {(items as any[]).map((i:any)=><option key={i.id} value={i.id}>{i.icon} {i.name}</option>)}
                  </select>
                </div>
                <div><div style={{fontSize:'.72rem',color:'var(--text-3)',marginBottom:3}}>Qty</div><input className="form-input" type="number" style={{width:'100%'}} value={poItemRow.qtyOrdered} onChange={e=>setPoItemRow(s=>({...s,qtyOrdered:e.target.value}))} /></div>
                <div><div style={{fontSize:'.72rem',color:'var(--text-3)',marginBottom:3}}>Unit Cost</div><input className="form-input" type="number" style={{width:'100%'}} value={poItemRow.unitCost} onChange={e=>setPoItemRow(s=>({...s,unitCost:e.target.value}))} /></div>
                <button className="btn btn-ghost" style={{height:36}} onClick={()=>{
                  const it=(items as any[]).find((x:any)=>x.id===poItemRow.itemId)
                  setPoItems(p=>[...p,{itemId:poItemRow.itemId,itemName:it?.name||'Custom Item',qtyOrdered:Number(poItemRow.qtyOrdered)||1,unitCost:Number(poItemRow.unitCost)||0}])
                  setPoItemRow({itemId:'',qtyOrdered:'1',unitCost:''})
                }}>+ Add</button>
              </div>
              {poItems.length>0&&(<div style={{background:'var(--bg-2)',borderRadius:8,padding:12,marginBottom:12}}>
                {poItems.map((pi,idx)=>(<div key={idx} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'4px 0',fontSize:'.82rem'}}>
                  <span>{pi.itemName} x {pi.qtyOrdered}</span>
                  <div style={{display:'flex',gap:12,alignItems:'center'}}>
                    <span className="mono">{fmt(pi.unitCost*pi.qtyOrdered)}</span>
                    <button onClick={()=>setPoItems(p=>p.filter((_,i)=>i!==idx))} style={{background:'none',border:'none',cursor:'pointer',color:'var(--text-3)'}}>x</button>
                  </div>
                </div>))}
                <div style={{display:'flex',justifyContent:'space-between',fontWeight:700,borderTop:'1px solid var(--border-1)',marginTop:8,paddingTop:8,fontSize:'.85rem'}}>
                  <span>Total</span><span style={{color:'var(--gold)'}}>{fmt(poItems.reduce((s,i)=>s+i.unitCost*i.qtyOrdered,0))}</span>
                </div>
              </div>)}
            </div>
            <button className="btn btn-primary" onClick={()=>createPOMut.mutate()} disabled={!newPO.vendorId||poItems.length===0||createPOMut.isLoading}>
              {createPOMut.isLoading?'Creating...':'Create Purchase Order'}
            </button>
          </div>
          <div className="card" style={{padding:0}}>
            <table className="data-table">
              <thead><tr><th>PO #</th><th>Vendor</th><th>Items</th><th>Total</th><th>Status</th><th>Expected</th><th>Actions</th></tr></thead>
              <tbody>
                {(purchaseOrders as any[]).length?(purchaseOrders as any[]).map((po:any)=>(<>
                  <tr key={po.id} style={{cursor:'pointer'}} onClick={()=>setExpandedPO(expandedPO===po.id?null:po.id)}>
                    <td className="mono" style={{color:'var(--gold)',fontWeight:600}}>{po.poNumber}</td>
                    <td style={{fontWeight:500}}>{po.vendorName}</td>
                    <td className="mono">{po.itemCount}</td>
                    <td className="mono">{fmt(po.subtotal)}</td>
                    <td><span className={"badge "+(po.status==='received'?'badge-green':po.status==='draft'?'badge-muted':po.status==='sent'?'badge-blue':'badge-amber')}>{po.status}</span></td>
                    <td style={{fontSize:'.82rem',color:'var(--text-3)'}}>{po.expectedDate?new Date(po.expectedDate).toLocaleDateString():'—'}</td>
                    <td><div style={{display:'flex',gap:6}} onClick={e=>e.stopPropagation()}>
                      {po.status==='draft'&&<button className="btn btn-ghost btn-sm" onClick={()=>updatePOMut.mutate({id:po.id,status:'sent'})}>Mark Sent</button>}
                      {po.status==='sent'&&<button className="btn btn-ghost btn-sm" style={{color:'var(--green)'}} onClick={()=>updatePOMut.mutate({id:po.id,status:'received'})}>Receive</button>}
                    </div></td>
                  </tr>
                  {expandedPO===po.id&&po.items&&(<tr key={po.id+'-exp'}>
                    <td colSpan={7} style={{background:'var(--bg-2)',padding:'8px 16px'}}>
                      <table style={{width:'100%',fontSize:'.8rem'}}>
                        <thead><tr style={{color:'var(--text-3)'}}><th style={{textAlign:'left',padding:'2px 8px'}}>Item</th><th style={{textAlign:'right',padding:'2px 8px'}}>Qty</th><th style={{textAlign:'right',padding:'2px 8px'}}>Unit Cost</th><th style={{textAlign:'right',padding:'2px 8px'}}>Total</th></tr></thead>
                        <tbody>{po.items.map((li:any)=>(<tr key={li.id}><td style={{padding:'2px 8px'}}>{li.itemName}</td><td className="mono" style={{textAlign:'right',padding:'2px 8px'}}>{li.qtyOrdered}</td><td className="mono" style={{textAlign:'right',padding:'2px 8px'}}>{fmt(li.unitCost)}</td><td className="mono" style={{textAlign:'right',padding:'2px 8px'}}>{fmt(li.subtotal)}</td></tr>))}</tbody>
                      </table>
                    </td>
                  </tr>)}
                </>)):<tr><td colSpan={7} style={{textAlign:'center',color:'var(--text-3)',padding:32}}>No purchase orders yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab==='inventory' && (
        <div style={{display:'grid',gap:16}}>
          {(lowStock as any[]).length>0&&(<div className="card" style={{borderColor:'var(--amber)'}}>
            <div className="card-header"><span className="card-title" style={{color:'var(--amber)'}}>Low Stock ({(lowStock as any[]).length} items)</span></div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(200px,1fr))',gap:10,marginTop:12}}>
              {(lowStock as any[]).map((item:any)=>(<div key={item.id} style={{background:'var(--bg-1)',borderRadius:8,padding:'10px 14px',border:'1px solid var(--border-1)'}}>
                <div style={{fontWeight:600,fontSize:'.85rem'}}>{item.icon} {item.name}</div>
                <div style={{fontSize:'.75rem',color:'var(--text-3)',marginTop:2}}>{item.vendorName||'No vendor linked'}</div>
                <div style={{marginTop:6,display:'flex',justifyContent:'space-between'}}>
                  <span style={{color:'var(--amber)',fontWeight:700}}>{item.stockQty} left</span>
                  <span style={{fontSize:'.72rem',color:'var(--text-3)'}}>min {item.stockMin}</span>
                </div>
              </div>))}
            </div>
          </div>)}
          <div className="card" style={{padding:0}}>
            <div className="card-header" style={{padding:'16px 20px'}}><span className="card-title">Stock Overview</span></div>
            <table className="data-table">
              <thead><tr><th>Item</th><th>Category</th><th>In Stock</th><th>Min</th><th>Max</th><th>Status</th><th>Adjust</th></tr></thead>
              <tbody>
                {(items as any[]).filter((i:any)=>i.stockQty<999).map((item:any)=>(<tr key={item.id}>
                  <td style={{fontWeight:500}}>{item.icon} {item.name}</td>
                  <td><span className="badge badge-muted">{item.category}</span></td>
                  <td className="mono" style={{fontWeight:700,color:item.stockQty===0?'var(--red)':item.stockQty<=item.stockMin?'var(--amber)':'var(--text-0)'}}>{item.stockQty}</td>
                  <td className="mono" style={{color:'var(--text-3)'}}>{item.stockMin}</td>
                  <td className="mono" style={{color:'var(--text-3)'}}>{item.stockMax}</td>
                  <td>{item.stockQty===0?<span className="badge badge-red">Out</span>:item.stockQty<=item.stockMin?<span className="badge badge-amber">Low</span>:<span className="badge badge-green">OK</span>}</td>
                  <td><button className="btn btn-ghost btn-sm" onClick={async()=>{
                    const n=prompt('Adjust qty by (negative to reduce):')
                    if(!n||isNaN(Number(n)))return
                    await apiPost("/pos/items/"+item.id+"/adjust-stock",{changeQty:Number(n),reason:'manual'})
                    qc.invalidateQueries('pos-items');qc.invalidateQueries('pos-low-stock');qc.invalidateQueries('pos-inventory-log')
                  }}>+/- Adjust</button></td>
                </tr>))}
              </tbody>
            </table>
          </div>
          <div className="card" style={{padding:0}}>
            <div className="card-header" style={{padding:'16px 20px'}}><span className="card-title">Stock Movement Log</span></div>
            <table className="data-table">
              <thead><tr><th>Date</th><th>Item</th><th>Change</th><th>Before</th><th>After</th><th>Reason</th></tr></thead>
              <tbody>
                {(inventoryLog as any[]).length?(inventoryLog as any[]).map((log:any)=>(<tr key={log.id}>
                  <td className="mono" style={{fontSize:'.78rem',color:'var(--text-3)'}}>{new Date(log.createdAt).toLocaleDateString()}</td>
                  <td style={{fontWeight:500}}>{log.itemIcon} {log.itemName}</td>
                  <td className="mono" style={{fontWeight:700,color:log.changeQty>0?'var(--green)':'var(--red)'}}>{log.changeQty>0?'+':''}{log.changeQty}</td>
                  <td className="mono">{log.stockBefore}</td>
                  <td className="mono">{log.stockAfter}</td>
                  <td><span className="badge badge-muted">{log.reason}</span></td>
                </tr>)):<tr><td colSpan={6} style={{textAlign:'center',color:'var(--text-3)',padding:32}}>No stock movements yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {editItem&&(<div className="modal-overlay" onClick={()=>setEditItem(null)}><div className="modal" style={{maxWidth:520}} onClick={e=>e.stopPropagation()}>
        <div className="modal-header"><span className="modal-title">{editItem.icon} Edit {editItem.name}</span><button className="btn btn-ghost btn-sm" onClick={()=>setEditItem(null)}>x</button></div>
        <div style={{padding:'0 24px 24px',display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
          <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Name</div><input className="form-input" style={{width:'100%'}} value={editItem.name} onChange={e=>setEditItem((s:any)=>({...s,name:e.target.value}))} /></div>
          <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Icon</div><input className="form-input" style={{width:'100%'}} value={editItem.icon} onChange={e=>setEditItem((s:any)=>({...s,icon:e.target.value}))} /></div>
          <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Category</div><select className="form-select" style={{width:'100%'}} value={editItem.category} onChange={e=>setEditItem((s:any)=>({...s,category:e.target.value}))}>{CATEGORIES.map(c=><option key={c} value={c}>{c}</option>)}</select></div>
          <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Sell Price</div><input className="form-input" style={{width:'100%'}} type="number" value={editItem._sell} onChange={e=>setEditItem((s:any)=>({...s,_sell:e.target.value}))} /></div>
          <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Cost Price</div><input className="form-input" style={{width:'100%'}} type="number" value={editItem._cost} onChange={e=>setEditItem((s:any)=>({...s,_cost:e.target.value}))} /></div>
          <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Tax Rate %</div><input className="form-input" style={{width:'100%'}} type="number" value={editItem._tax} onChange={e=>setEditItem((s:any)=>({...s,_tax:e.target.value}))} /></div>
          <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Stock Qty</div><input className="form-input" style={{width:'100%'}} type="number" value={editItem._stock} onChange={e=>setEditItem((s:any)=>({...s,_stock:e.target.value}))} /></div>
          <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Stock Min</div><input className="form-input" style={{width:'100%'}} type="number" value={editItem._min} onChange={e=>setEditItem((s:any)=>({...s,_min:e.target.value}))} /></div>
          <div style={{gridColumn:'1/-1',marginTop:8}}><button className="btn btn-primary" style={{width:'100%'}} onClick={()=>updateItemMut.mutate({name:editItem.name,icon:editItem.icon,category:editItem.category,sellPrice:Number(editItem._sell),costPrice:Number(editItem._cost),taxRate:Number(editItem._tax)/100,stockQty:Number(editItem._stock),stockMin:Number(editItem._min),chargeEligible:editItem.chargeEligible})} disabled={updateItemMut.isLoading}>{updateItemMut.isLoading?'Saving...':'Save Changes'}</button></div>
        </div>
      </div></div>)}

      {editVendor&&(<div className="modal-overlay" onClick={()=>setEditVendor(null)}><div className="modal" style={{maxWidth:520}} onClick={e=>e.stopPropagation()}>
        <div className="modal-header"><span className="modal-title">Edit Vendor — {editVendor.name}</span><button className="btn btn-ghost btn-sm" onClick={()=>setEditVendor(null)}>x</button></div>
        <div style={{padding:'0 24px 24px',display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
          <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Name</div><input className="form-input" style={{width:'100%'}} value={editVendor.name} onChange={e=>setEditVendor((s:any)=>({...s,name:e.target.value}))} /></div>
          <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Contact</div><input className="form-input" style={{width:'100%'}} value={editVendor.contactName||''} onChange={e=>setEditVendor((s:any)=>({...s,contactName:e.target.value}))} /></div>
          <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Email</div><input className="form-input" style={{width:'100%'}} value={editVendor.email||''} onChange={e=>setEditVendor((s:any)=>({...s,email:e.target.value}))} /></div>
          <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Phone</div><input className="form-input" style={{width:'100%'}} value={editVendor.phone||''} onChange={e=>setEditVendor((s:any)=>({...s,phone:e.target.value}))} /></div>
          <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Lead Time (days)</div><input className="form-input" type="number" style={{width:'100%'}} value={editVendor.leadTimeDays||3} onChange={e=>setEditVendor((s:any)=>({...s,leadTimeDays:Number(e.target.value)}))} /></div>
          <div style={{display:'flex',alignItems:'center',gap:8,paddingTop:20}}><input type="checkbox" id="va" checked={editVendor.isActive} onChange={e=>setEditVendor((s:any)=>({...s,isActive:e.target.checked}))} /><label htmlFor="va" style={{fontSize:'.82rem'}}>Active</label></div>
          <div style={{gridColumn:'1/-1',marginTop:8}}><button className="btn btn-primary" style={{width:'100%'}} onClick={()=>updateVendorMut.mutate({name:editVendor.name,contactName:editVendor.contactName,email:editVendor.email,phone:editVendor.phone,leadTimeDays:editVendor.leadTimeDays,isActive:editVendor.isActive})} disabled={updateVendorMut.isLoading}>{updateVendorMut.isLoading?'Saving...':'Save Changes'}</button></div>
        </div>
      </div></div>)}

      {readerModal&&(<div className="modal-overlay" onClick={()=>setReaderModal(false)}><div className="modal" style={{maxWidth:420}} onClick={e=>e.stopPropagation()}>
        <div className="modal-header"><span className="modal-title">Connect Card Reader</span><button className="btn btn-ghost btn-sm" onClick={()=>setReaderModal(false)}>x</button></div>
        <div style={{padding:'0 24px 24px'}}>
          {terminalStatus==='discovering'&&<div style={{textAlign:'center',padding:24,color:'var(--text-3)'}}>Searching...</div>}
          {terminalStatus==='error'&&<div style={{color:'var(--red)',fontSize:'.82rem',marginBottom:12}}>{terminalError}</div>}
          {readers.length===0&&terminalStatus==='idle'&&(<div style={{textAlign:'center',padding:24}}><div style={{color:'var(--text-3)',fontSize:'.85rem',marginBottom:16}}>No readers found</div><button className="btn btn-primary" onClick={discoverAndConnect}>Search Again</button></div>)}
          {readers.map((r:any)=>(<div key={r.id} onClick={()=>connectToReader(r)} style={{border:'1px solid var(--border-1)',borderRadius:8,padding:'12px 16px',marginBottom:8,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'space-between'}} onMouseEnter={e=>(e.currentTarget.style.borderColor='var(--gold)')} onMouseLeave={e=>(e.currentTarget.style.borderColor='var(--border-1)')}>
            <div><div style={{fontWeight:600,fontSize:'.88rem'}}>{r.label||r.serialNumber}</div><div style={{fontSize:'.75rem',color:'var(--text-3)'}}>{r.deviceType} - {r.status}</div></div>
            <span style={{color:'var(--gold)',fontSize:'.82rem'}}>Connect</span>
          </div>))}
        </div>
      </div></div>)}

      {openItem.show&&(<div className="modal-overlay" onClick={()=>setOpenItem(o=>({...o,show:false}))}><div className="modal" style={{maxWidth:360}} onClick={e=>e.stopPropagation()}>
        <div className="modal-header"><span className="modal-title">Open Item</span><button className="btn btn-ghost btn-sm" onClick={()=>setOpenItem(o=>({...o,show:false}))}>x</button></div>
        <div style={{padding:'0 24px 24px',display:'grid',gap:12}}>
          <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Description</div><input className="form-input" style={{width:'100%'}} placeholder="Item name" value={openItem.name} onChange={e=>setOpenItem(o=>({...o,name:e.target.value}))} /></div>
          <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Price</div><input className="form-input" style={{width:'100%'}} type="number" value={openItem.price} onChange={e=>setOpenItem(o=>({...o,price:e.target.value}))} /></div>
          <button className="btn btn-primary" onClick={addOpenItem} disabled={!openItem.name||!openItem.price}>Add to Cart</button>
        </div>
      </div></div>)}

      {refundModal.show&&(<div className="modal-overlay" onClick={()=>setRefundModal({show:false,tx:null})}><div className="modal" style={{maxWidth:380}} onClick={e=>e.stopPropagation()}>
        <div className="modal-header"><span className="modal-title">Refund Transaction</span><button className="btn btn-ghost btn-sm" onClick={()=>setRefundModal({show:false,tx:null})}>x</button></div>
        <div style={{padding:'0 24px 24px',display:'grid',gap:12}}>
          <div style={{fontSize:'.85rem',color:'var(--text-3)'}}>Original total: <strong style={{color:'var(--text-0)'}}>{fmt(refundModal.tx?.total)}</strong></div>
          <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Refund Amount (blank for full refund)</div><input className="form-input" style={{width:'100%'}} type="number" value={refundAmt} onChange={e=>setRefundAmt(e.target.value)} /></div>
          <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Reason</div><input className="form-input" style={{width:'100%'}} value={refundReason} onChange={e=>setRefundReason(e.target.value)} /></div>
          <button className="btn btn-primary" onClick={()=>refundMut.mutate()} disabled={refundMut.isLoading}>Process Refund</button>
        </div>
      </div></div>)}
    </div>
  )
}
