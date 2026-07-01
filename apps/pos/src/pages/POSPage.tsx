import { useState, useEffect } from 'react'
import {
  discoverReaders, connectReader, collectCardPayment, cancelCurrentPayment,
  createTerminalIntent, processIntentOnReader, pollPiUntilTerminal,
  captureTerminalIntent, cancelTerminalIntent,
  listRegisteredReaders, registerNewReader, archiveRegisteredReader,
  type RegisteredReader,
} from '../lib/terminal'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { apiGet, apiPost, apiPatch, apiDel } from '../lib/api'
import { enqueue as enqueueSync, preloadMapping, mintClientId } from '../lib/syncQueue'

// S243: Active reader for the terminal flow. Two paths:
//   - 'smart'     — server-driven (S700, WisePOS E, etc.) registered
//                    via /pos/terminal/readers. Backend pushes the PI;
//                    frontend polls status.
//   - 'bluetooth' — client-driven via the Stripe Terminal JS SDK
//                    (handheld readers paired through the browser).
type ActiveReader =
  | { type: 'smart'; stripeReaderId: string; nickname: string }
  | { type: 'bluetooth'; sdkReader: any; label: string }
const fmt = (n: any) => n != null ? `$${Number(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}` : '—'
const pct = (n: any) => n != null ? `${(Number(n)*100).toFixed(2)}%` : '—'

const STATUS_MAP: Record<string,string> = { completed:'badge-green', voided:'badge-red', refunded:'badge-amber', partial_refund:'badge-amber' }
const METHOD_MAP: Record<string,string> = { cash:'badge-green', card:'badge-blue', charge:'badge-amber' }
// S512 LAUNCH: the "charge" (FlexCharge) tender is hidden at launch with the
// rest of the Flex Suite. The button is filtered out of the register picker so
// a clerk can only ring cash/card; all charge code stays for post-launch.
const LAUNCH_HIDE_CHARGE = true
const TAX_TYPES = ['state','city','county','special']
// S218: pos_categories is the source of truth for the category list.
// Pre-S218 this file used a hardcoded ['fuel','amenity','laundry',
// 'parking','fee','misc']. The DB pos_categories table + /api/pos/
// categories endpoint already existed with the same set seeded as
// DEFAULT_CATEGORIES in the API; this file just wasn't consuming them.
// S227: FALLBACK_CATEGORIES removed — the FK refactor means dropdown
// values must be category UUIDs, not name strings. The very-first-load
// case now shows an empty dropdown until /pos/categories resolves;
// landlord can't submit an item without a real category id anyway.

interface CartItem { id:string; name:string; price:number; qty:number; tax:number; cat:string; icon:string; chargeEligible:boolean }

// Preset icons for categories AND items — a clickable dropdown replaces the old
// free-text box (you can't type an arbitrary character in as an "icon"). ~130.
const POS_ICON_OPTIONS = [
  '📦','🛒','🛍️','🏷️','🎁','🎟️','💳','🧾',
  '⛽','🔥','🪵','🔋','💡','🔌','🕯️','🔦','♨️','🧯',
  '🍔','🌭','🍕','🌮','🌯','🥪','🍟','🥨','🍿','🥓','🥚','🧀','🥖','🍞',
  '🍩','🍪','🍫','🍬','🍭','🧁','🍰','🍦','🍨',
  '🍎','🍌','🍇','🍓','🍊','🍉','🥑','🥕','🌽','🥔','🥜','🍅',
  '☕','🥤','🧃','🧋','🍵','🍺','🍷','🥛','🧉','🍶','🧊',
  '🧺','🧹','🧴','🧻','🧼','🪣','🧽','🪥','🚿','🛁','🚽',
  '🔧','🛠️','🔨','🪛','🔩','⚙️','🪚','🧲','🪝',
  '🏕️','⛺','🎣','🚲','🛶','🧭','🏊','🏖️','⛱️','🥾','🌅',
  '🅿️','🚗','🚙','🚐','🛻','🏍️','🛞','🛴',
  '🐾','🦴','🐕','🐈','🐟',
  '🩹','💊','🪒','👕','🧢','🕶️','☂️','🧦','🧤',
  '🔑','🗝️','⏰','✂️','🖊️','📎','🔒','🎈','🧸','🎀',
  '🎱','🎰','🎮','🎲','🏓','⚽','🎯',
  '🌱','🪴','🌸','🌵','🍄',
]

export function POSPage() {
  const qc = useQueryClient()
  const [tab, setTab] = useState<'register'|'history'|'items'|'categories'|'taxes'|'discounts'|'vendors'|'orders'|'inventory'|'readers'>('register')

  const [cart, setCart] = useState<CartItem[]>([])
  // S263/S264: server-of-record cart sync. clientSessionId is the LOCAL
  // identifier of the active session — generated at session-open time
  // and used to enqueue subsequent mutations through services/syncQueue.
  // The server-side pos_sessions.id resolves asynchronously via the
  // queue's clientId→serverId mapping. For resumed sessions, the server
  // id is pre-mapped so the queue resolves it immediately.
  const [clientSessionId, setClientSessionId] = useState<string|null>(null)
  const [openTabBanner, setOpenTabBanner] = useState<{ id:string; total:number; openedAt:string; itemCount:number }|null>(null)
  const [method, setMethod] = useState<'cash'|'card'|'charge'>('cash')
  const [tenantId, setTenantId] = useState('')
  // S254: FlexCharge customer can be a tenant OR a pos_customer
  // (merchant-owned non-tenant). UI picks one type at a time.
  const [chargeCustomerType, setChargeCustomerType] = useState<'tenant'|'pos_customer'>('tenant')
  const [posCustomerId, setPosCustomerId] = useState('')
  const [cashGiven, setCashGiven] = useState('')
  const [filterCat, setFilterCat] = useState('all')
  // S216: items-tab property filter. 'all' = no filter, 'company-wide'
  // = items with NULL property_id, or a specific property uuid.
  const [filterItemProperty, setFilterItemProperty] = useState<string>('all')
  const [receipt, setReceipt] = useState<any>(null)
  const [appliedDiscount, setAppliedDiscount] = useState<any>(null)
  const [discountCode, setDiscountCode] = useState('')
  const [openItem, setOpenItem] = useState({ name:'', price:'', show:false })
  const [refundModal, setRefundModal] = useState<{show:boolean; tx:any}>({show:false,tx:null})
  const [refundAmt, setRefundAmt] = useState('')
  const [refundReason, setRefundReason] = useState('')
  // S339: refund_method enforcement. Cashier picks cash or check for
  // cash/card sales; FlexCharge sales reverse on the open account
  // (server forces 'charge' regardless of what we send).
  const [refundMethod, setRefundMethod] = useState<'cash'|'check'>('cash')
  const [readerModal, setReaderModal] = useState(false)
  const [readers, setReaders] = useState<any[]>([])  // Bluetooth-discovered SDK readers
  const [activeReader, setActiveReader] = useState<ActiveReader | null>(null)
  const [terminalStatus, setTerminalStatus] = useState<'idle'|'discovering'|'connecting'|'collecting'|'capturing'|'error'>('idle')
  const [terminalError, setTerminalError] = useState('')
  // S243: cart-level property — the PI is stamped with this and the
  // smart-reader selector filters to readers registered under it.
  // Card method requires a property; cash/charge don't.
  const [registerProperty, setRegisterProperty] = useState<string>('')
  // S243: Readers-tab register-new form.
  const [newReader, setNewReader] = useState({ propertyId: '', registrationCode: '', nickname: '' })
  const [editItem, setEditItem] = useState<any>(null)
  // S219: Manage Categories tab state.
  // S220: + propertyId on the Add form, + filterCategoryProperty for
  // the management-list filter (mirrors items + tax-rates filters).
  // propertyIds: [] = all properties (company-wide); a non-empty list scopes
  // the category to exactly those properties (toggle per property).
  const [newCategory, setNewCategory] = useState({ name:'', icon:'📦', sortOrder:'', propertyIds: [] as string[] })
  const [editCategory, setEditCategory] = useState<any>(null)
  const [filterCategoryProperty, setFilterCategoryProperty] = useState<string>('all')
  // Categories table sort — click a column header to sort; click again to flip.
  const [catSort, setCatSort] = useState<{ key: 'name' | 'property'; dir: 'asc' | 'desc' }>({ key: 'name', dir: 'asc' })
  const toggleCatSort = (key: 'name' | 'property') =>
    setCatSort(s => s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' })
  // New-category property picker is a popup (clearer than inline checkboxes).
  const [showCatPropPicker, setShowCatPropPicker] = useState(false)
  // Items table sort — click a column header to sort; click again to flip.
  const [itemSort, setItemSort] = useState<{ key: 'name'|'category'|'property'|'price'|'stock'; dir: 'asc'|'desc' }>({ key: 'name', dir: 'asc' })
  const toggleItemSort = (key: 'name'|'category'|'property'|'price'|'stock') =>
    setItemSort(s => s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' })
  // S227: form now stores categoryId (uuid). Default '' until categories
  // load, then we auto-pick the first available (see useEffect below).
  const [newItem, setNewItem] = useState({ name:'', categoryId:'', icon:'📦', sellPrice:'', costPrice:'', marginPct:'', taxCategoryId:'', chargeEligible:true, stockQty:'0', stockMin:'5', stockMax:'50', propertyId:'' as string })
  const [newTax, setNewTax] = useState({ name:'', rate:'', taxType:'state', appliesTo:'all', propertyId:'' as string })
  // S217: tax-rate list filter on the taxes tab.
  const [filterTaxProperty, setFilterTaxProperty] = useState<string>('all')
  const [newDiscount, setNewDiscount] = useState({ name:'', type:'percent', value:'', code:'' })
  const [newVendor, setNewVendor] = useState({ name:'', contactName:'', email:'', phone:'', address:'', leadTimeDays:'3', notes:'' })
  const [editVendor, setEditVendor] = useState<any>(null)
  const [newPO, setNewPO] = useState({ vendorId:'', notes:'', expectedDate:'' })
  const [poItems, setPoItems] = useState<{itemId:string;itemName:string;qtyOrdered:number;unitCost:number}[]>([])
  const [poItemRow, setPoItemRow] = useState({ itemId:'', qtyOrdered:'1', unitCost:'' })
  const [expandedPO, setExpandedPO] = useState<string|null>(null)

  const { data: items = [] } = useQuery<any[]>('pos-items', () => apiGet('/pos/items'))
  // POS #1: business-level default margin → drives item auto-pricing.
  const { data: posSettings } = useQuery<any>('pos-settings', () => apiGet<any>('/pos/settings'))
  const defaultMarginPct: number | null = posSettings?.defaultMarginPct ?? null
  const [marginEdit, setMarginEdit] = useState('')
  const saveMarginMut = useMutation(
    (v: string) => apiPatch('/pos/settings', { defaultMarginPct: v === '' ? null : Number(v) }),
    { onSuccess: () => qc.invalidateQueries('pos-settings') }
  )
  // S218: pos_categories from the API replaces the old hardcoded
  // CATEGORIES const. First GET auto-seeds defaults if empty.
  const { data: posCategories = [] } = useQuery<any[]>('pos-categories', () => apiGet('/pos/categories'))
  // S219: full list (incl. inactive) for the manage-categories tab.
  const { data: posCategoriesAll = [] } = useQuery<any[]>('pos-categories-all', () => apiGet('/pos/categories?all=1'), { enabled: tab==='categories' })
  const { data: tenants = [] } = useQuery<any[]>('tenants', () => apiGet('/tenants'))
  // S192: per-property POS — properties list feeds the property
  // selector on item create/edit. NotificationBell already pulls
  // /properties so this is in cache.
  const { data: properties = [] } = useQuery<any[]>('properties', () => apiGet('/properties'))
  // S254: pos_customers roster for FlexCharge non-tenant picker
  const { data: posCustomers = [] } = useQuery<any[]>('pos-customers', () => apiGet('/landlords/pos-customers'), { enabled: method==='charge' })
  const { data: taxRates = [] } = useQuery<any[]>('pos-tax-rates', () => apiGet('/pos/tax-rates'), { enabled: tab==='taxes'||tab==='register' })
  // Tax categories (simple: name + one rate). Items pick a tax category → rate.
  const { data: posTaxCategories = [] } = useQuery<any[]>('pos-tax-categories', () => apiGet('/pos/tax-categories'), { enabled: tab==='taxes'||tab==='items'||tab==='register' })
  const { data: discounts = [] } = useQuery<any[]>('pos-discounts', () => apiGet('/pos/discounts'), { enabled: tab==='discounts'||tab==='register' })
  const { data: txns = [], isLoading: txLoading } = useQuery<any[]>('pos-transactions', () => apiGet('/pos/transactions'), { enabled: tab==='history' })
  const { data: vendors = [] } = useQuery<any[]>('pos-vendors', () => apiGet('/pos/vendors'), { enabled: tab==='vendors'||tab==='orders' })
  const { data: purchaseOrders = [] } = useQuery<any[]>('pos-purchase-orders', () => apiGet('/pos/purchase-orders'), { enabled: tab==='orders' })
  const { data: inventoryLog = [] } = useQuery<any[]>('pos-inventory-log', () => apiGet('/pos/inventory-log'), { enabled: tab==='inventory' })
  const { data: lowStock = [] } = useQuery<any[]>('pos-low-stock', () => apiGet('/pos/low-stock'), { enabled: tab==='inventory' })

  // S243: smart readers registered to the cart's property — filters
  // the smart-reader selector in the charge modal. Re-fetches when
  // registerProperty changes. Also populates the Readers-tab table.
  const { data: registeredReaders = [] } = useQuery<RegisteredReader[]>(
    ['pos-terminal-readers', registerProperty || 'all'],
    () => listRegisteredReaders(registerProperty || undefined),
    { enabled: (tab==='register' && !!registerProperty) || tab==='readers' },
  )

  const categories = ['all', ...Array.from(new Set((items as any[]).map((i:any) => i.category)))]
  // S218 / S220: property-aware category filter for dropdown surfaces.
  // Replaces the old unconditional `categoryOptions` derivation —
  // every dropdown consumer now passes its form's propertyId so the
  // filter respects category scope.
  // - company-wide categories (propertyId NULL) appear everywhere
  // - property-scoped categories appear only when the consuming form's
  //   property matches
  // - company-wide consuming context (propertyId empty/null) sees only
  //   company-wide categories — picking a property-scoped category for
  //   a company-wide item is logically inconsistent
  // S227: returns {id, name, icon} so dropdowns can use the uuid as the
  // option value. Pre-S227 returned only name+icon and the dropdown
  // submitted the name string — the FK refactor moved the source of
  // truth to category_id.
  const categoriesForProperty = (propertyId: string | null | undefined): { id: string; name: string; icon: string }[] => {
    return (posCategories as any[])
      .filter((c:any) => {
        const ids = c.propertyIds as string[] | null | undefined
        if (!ids || ids.length === 0) return true   // all properties (company-wide)
        if (!propertyId) return false                // scoped category, no property context
        return ids.includes(propertyId)
      })
      .map((c:any) => ({ id: c.id, name: c.name, icon: c.icon || '📦' }))
  }
  // Register shows items for the selected property (+ any company-wide),
  // then the active category filter. Items are per-property, so ringing is
  // scoped to the chosen register/property.
  const visibleItems = (items as any[])
    .filter((i:any) => !registerProperty || !i.propertyId || i.propertyId === registerProperty)
    .filter((i:any) => filterCat === 'all' || i.category === filterCat)

  // S243: single-property landlords don't see a property selector —
  // auto-pick on first load so the card-charge flow Just Works. Multi-
  // property landlords explicitly choose per-sale.
  useEffect(() => {
    if (registerProperty) return
    if ((properties as any[]).length === 1) {
      setRegisterProperty((properties as any[])[0].id)
    }
  }, [properties, registerProperty])

  // S227: when categories load (or the form's property scope changes
  // such that newItem.categoryId no longer points at a visible category),
  // auto-pick the first available so the dropdown isn't empty. Misc
  // wins if present (matches the historical default).
  useEffect(() => {
    if (newItem.categoryId) {
      const visible = categoriesForProperty(newItem.propertyId).find(c => c.id === newItem.categoryId)
      if (visible) return
    }
    const list = categoriesForProperty(newItem.propertyId)
    if (list.length === 0) return
    const misc = list.find(c => c.name === 'Misc')
    setNewItem(s => ({ ...s, categoryId: (misc ?? list[0]).id }))
  }, [posCategories, newItem.propertyId])

  // S263: open-tab query (cross-terminal pickup + crash recovery). When
  // the register tab loads with a property selected and no live session,
  // surface a banner if there's an open tab on this property.
  const { data: openSessions = [] } = useQuery<any[]>(
    ['pos-sessions-open', registerProperty],
    () => apiGet(`/pos/sessions?status=open&propertyId=${registerProperty}`),
    { enabled: tab==='register' && !!registerProperty },
  )
  useEffect(() => {
    if (clientSessionId) { setOpenTabBanner(null); return }
    if (!openSessions || openSessions.length === 0) { setOpenTabBanner(null); return }
    const first = openSessions[0]
    setOpenTabBanner({
      id: first.id,
      total: Number(first.total ?? 0),
      openedAt: first.openedAt,
      itemCount: Number(first.itemCount ?? 0),
    })
  }, [openSessions, clientSessionId])

  // S263/S264: server-session helpers. ensureSession lazily mints a
  // client-side uuid AND enqueues OPEN_SESSION. The server-side
  // pos_sessions row is created async (resolves via the queue mapping).
  // Until the OPEN_SESSION drains, subsequent item ops queue behind it
  // — the FIFO drain serializes them.
  function ensureSession(): string|null {
    if (clientSessionId) return clientSessionId
    if (!registerProperty) return null
    const csid = mintClientId()
    setClientSessionId(csid)
    void enqueueSync({
      op: 'OPEN_SESSION',
      clientSessionId: csid,
      payload: {
        propertyId: registerProperty,
        tenantId: method==='charge' && chargeCustomerType==='tenant' && tenantId ? tenantId : null,
        posCustomerId: method==='charge' && chargeCustomerType==='pos_customer' && posCustomerId ? posCustomerId : null,
      },
    })
    return csid
  }

  async function resumeSession(id: string) {
    try {
      const res: any = await apiGet(`/pos/sessions/${id}`)
      const items = res?.items || res?.data?.items || []
      // Pre-map server ids → self so the queue resolves them synchronously
      // for any subsequent PATCH/DELETE/VOID against this session.
      await preloadMapping(id, id)
      const restored: CartItem[] = []
      for (const it of items) {
        const serverItemId = it.id
        // Each restored line is its own "clientId" too (self-mapped).
        await preloadMapping(serverItemId, serverItemId)
        restored.push({
          id: it.itemId || ('open-' + serverItemId),
          name: it.itemName,
          price: Number(it.unitPrice),
          qty: Number(it.qty),
          tax: Number(it.taxRate),
          cat: it.itemCategory ?? 'misc',
          icon: '📦',
          chargeEligible: false,
          _sessionItemId: serverItemId,
        } as any)
      }
      setCart(restored)
      setClientSessionId(id)
      setOpenTabBanner(null)
    } catch (e) {
      console.error('[pos-session] resume failed', e)
    }
  }

  async function discardOpenTab(id: string) {
    try {
      // Discard is a direct synchronous call (we know the server id and
      // we're not editing the cart). Best-effort; if it fails the banner
      // re-appears on next refresh.
      await apiPost(`/pos/sessions/${id}/void`, { reason: 'discarded_at_terminal_load' })
      qc.invalidateQueries(['pos-sessions-open', registerProperty])
      setOpenTabBanner(null)
    } catch (e) {
      console.error('[pos-session] discard failed', e)
    }
  }

  const addToCart = async (item: any) => {
    const csid = ensureSession()
    if (!csid) return
    const clientItemId = mintClientId()
    void enqueueSync({
      op: 'ADD_ITEM',
      clientSessionId: csid,
      clientItemId,
      payload: {
        itemId: item.id,
        itemName: item.name,
        itemCategory: item.category || null,
        qty: 1,
        unitPrice: Number(item.sellPrice),
        taxRate: Number(item.taxRate) || 0,
      },
    })
    setCart(c => {
      const ex = c.find(x => x.id === item.id)
      // S264: when the user double-taps an item the local merge stays —
      // visual qty goes up — but a NEW ADD_ITEM mutation still fires.
      // Server resolves into two pos_session_items rows; resume after a
      // tab reopen will show them split. Acceptable for v1; merge logic
      // can come later if line clutter becomes a complaint.
      if (ex) return c.map(x => x.id===item.id ? {...x,qty:x.qty+1, _sessionItemId: (x as any)._sessionItemId ?? clientItemId} as any : x)
      return [...c, { id:item.id, name:item.name, price:Number(item.sellPrice), qty:1, tax:Number(item.taxRate), cat:item.category, icon:item.icon, chargeEligible:item.chargeEligible, _sessionItemId: clientItemId } as any]
    })
  }
  const addOpenItem = async () => {
    if (!openItem.name || !openItem.price) return
    const csid = ensureSession()
    if (!csid) return
    const clientItemId = mintClientId()
    void enqueueSync({
      op: 'ADD_ITEM',
      clientSessionId: csid,
      clientItemId,
      payload: {
        itemName: openItem.name,
        qty: 1,
        unitPrice: Number(openItem.price),
      },
    })
    setCart(c => [...c, { id:'open-'+Date.now(), name:openItem.name, price:Number(openItem.price), qty:1, tax:0, cat:'misc', icon:'📝', chargeEligible:false, _sessionItemId: clientItemId } as any])
    setOpenItem({ name:'', price:'', show:false })
  }
  const updateQty = async (id:string, delta:number) => {
    const line = cart.find(x => x.id === id)
    if (!line) return
    const newQty = Math.max(0, line.qty + delta)
    const csid = clientSessionId
    const lineClientId = (line as any)._sessionItemId
    if (csid && lineClientId) {
      if (newQty === 0) {
        void enqueueSync({
          op: 'DELETE_ITEM',
          clientSessionId: csid,
          clientItemId: lineClientId,
          payload: {},
        })
      } else {
        void enqueueSync({
          op: 'PATCH_ITEM',
          clientSessionId: csid,
          clientItemId: lineClientId,
          payload: { qty: newQty },
        })
      }
    }
    setCart(c => c.map(x => x.id===id ? {...x,qty:newQty} : x).filter(x=>x.qty>0))
  }

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

  // S243: optional stripePaymentIntentId from the terminal capture flow.
  // The S242 backend gate validates it against the landlord's Connect
  // account (status='succeeded', metadata.gam_purpose='pos_terminal',
  // amount matches the server-computed total). Cash/charge paths pass
  // null and skip validation.
  const checkoutMut = useMutation(
    (stripePaymentIntentId?: string) => apiPost('/pos/transactions', {
      items: cart.map(i => ({ id:i.id.startsWith('open-')?null:i.id, name:i.name, qty:i.qty, price:i.price, tax:i.tax, cat:i.cat })),
      paymentMethod:method,
      // S254: charge mode posts customer + property scoping for FlexCharge
      tenantId: method==='charge' && chargeCustomerType==='tenant' ? (tenantId||null) : (method==='charge' ? null : (tenantId||null)),
      posCustomerId: method==='charge' && chargeCustomerType==='pos_customer' ? (posCustomerId||null) : null,
      propertyId: method==='charge' ? (registerProperty||null) : null,
      subtotal:discountedSubtotal, taxAmount, surcharge, total, changeGiven:changeDue,
      discountAmount:discountAmt, discountReason:appliedDiscount?.name||null,
      stripePaymentIntentId: stripePaymentIntentId || null,
    }),
    { onSuccess: async (res:any) => {
      setReceipt({ ...res.data, cartItems:cart, subtotal, discountAmt, taxAmount, surcharge, total, changeDue, method })
      // S263/S264: link the live session to this transaction via the
      // queue. FIFO order guarantees the OPEN_SESSION + ADD_ITEMs have
      // already drained by the time the cashier reached checkout (those
      // mutations need network and so does /pos/transactions). The
      // session/complete endpoint is idempotent.
      const txId = res?.data?.id
      if (clientSessionId && txId) {
        void enqueueSync({
          op: 'COMPLETE_SESSION',
          clientSessionId,
          payload: { transactionId: txId },
        })
      }
      setClientSessionId(null)
      setCart([]); setCashGiven(''); setTenantId(''); setPosCustomerId(''); setAppliedDiscount(null)
      qc.invalidateQueries('pos-transactions'); qc.invalidateQueries('pos-items')
      qc.invalidateQueries(['pos-sessions-open', registerProperty])
    }}
  )

  const toggleChargeMut = useMutation(({ id, val }:{ id:string; val:boolean }) => apiPatch(`/pos/items/${id}`, { chargeEligible:val }), { onSuccess: () => qc.invalidateQueries('pos-items') })
  const toggleActiveMut = useMutation(({ id, val }:{ id:string; val:boolean }) => apiPatch(`/pos/items/${id}`, { isActive:val }), { onSuccess: () => qc.invalidateQueries('pos-items') })
  const createItemMut = useMutation(() => apiPost('/pos/items', { ...newItem, propertyId: newItem.propertyId || null, categoryId: newItem.categoryId, costPrice:Number(newItem.costPrice), sellPrice:Number(newItem.sellPrice), marginPct: newItem.marginPct === '' ? null : Number(newItem.marginPct), taxCategoryId: newItem.taxCategoryId || null, chargeEligible:newItem.chargeEligible, stockQty:Number(newItem.stockQty), stockMin:Number(newItem.stockMin), stockMax:Number(newItem.stockMax) }), { onSuccess: () => { qc.invalidateQueries('pos-items'); setNewItem({ name:'', categoryId:'', icon:'📦', sellPrice:'', costPrice:'', marginPct: defaultMarginPct!=null?String(defaultMarginPct):'', taxCategoryId:'', chargeEligible:true, stockQty:'0', stockMin:'5', stockMax:'50', propertyId:'' }) }, onError: (e:any) => alert(e?.response?.data?.error?.message || e?.response?.data?.error || 'Could not add item — set name, sell price, category, and property') })

  // POS #1 auto-pricing helpers. Margin is gross % of sell price:
  // sell = cost / (1 - margin/100); margin = (sell - cost) / sell * 100.
  const round2 = (n: number) => Math.round(n * 100) / 100
  const priceFromMargin = (cost: number, margin: number) =>
    (margin >= 0 && margin < 100 && cost > 0) ? round2(cost / (1 - margin / 100)) : null
  const setItemCost = (v: string) => setNewItem(s => {
    const cost = Number(v), m = Number(s.marginPct)
    const next = { ...s, costPrice: v }
    if (s.marginPct !== '' && cost > 0) { const p = priceFromMargin(cost, m); if (p != null) next.sellPrice = String(p) }
    return next
  })
  const setItemMargin = (v: string) => setNewItem(s => {
    const cost = Number(s.costPrice), m = Number(v)
    const next = { ...s, marginPct: v }
    const p = priceFromMargin(cost, m); if (p != null) next.sellPrice = String(p)
    return next
  })
  const setItemSell = (v: string) => setNewItem(s => {
    const sell = Number(v), cost = Number(s.costPrice)
    const next = { ...s, sellPrice: v }
    if (sell > 0 && cost > 0) next.marginPct = String(round2(((sell - cost) / sell) * 100))
    return next
  })
  // Seed the item form's margin with the business default once it loads.
  useEffect(() => {
    if (defaultMarginPct != null) setNewItem(s => s.marginPct === '' && s.costPrice === '' && s.sellPrice === '' ? { ...s, marginPct: String(defaultMarginPct) } : s)
  }, [defaultMarginPct])
  // Override-confirm: if a default margin exists and this item's margin
  // deviates from it, confirm before saving.
  const submitNewItem = () => {
    if (defaultMarginPct != null && newItem.marginPct !== '') {
      const m = Number(newItem.marginPct)
      if (Math.abs(m - defaultMarginPct) > 0.5) {
        if (!window.confirm(`This price is a ${m.toFixed(1)}% margin, not your ${defaultMarginPct}% default. Save anyway?`)) return
      }
    }
    createItemMut.mutate()
  }
  const updateItemMut = useMutation((data:any) => apiPatch(`/pos/items/${editItem.id}`, data), { onSuccess: () => { qc.invalidateQueries('pos-items'); setEditItem(null) } })

  const createVendorMut = useMutation(() => apiPost('/pos/vendors', { ...newVendor, leadTimeDays:Number(newVendor.leadTimeDays) }), { onSuccess: () => { qc.invalidateQueries('pos-vendors'); setNewVendor({ name:'', contactName:'', email:'', phone:'', address:'', leadTimeDays:'3', notes:'' }) } })
  const updateVendorMut = useMutation((data:any) => apiPatch(`/pos/vendors/${editVendor.id}`, data), { onSuccess: () => { qc.invalidateQueries('pos-vendors'); setEditVendor(null) } })

  const createPOMut = useMutation(() => apiPost('/pos/purchase-orders', { ...newPO, items: poItems }), { onSuccess: () => { qc.invalidateQueries('pos-purchase-orders'); setNewPO({ vendorId:'', notes:'', expectedDate:'' }); setPoItems([]) } })
  const updatePOMut = useMutation(({ id, status }:{ id:string; status:string }) => apiPatch(`/pos/purchase-orders/${id}`, { status }), { onSuccess: () => qc.invalidateQueries('pos-purchase-orders') })

  // S219: category CRUD. Invalidates both the active-only query (drives
  // dropdowns) and the all-inclusive query (drives the manage tab).
  const invalCats = () => { qc.invalidateQueries('pos-categories'); qc.invalidateQueries('pos-categories-all') }
  const createCategoryMut = useMutation(
    () => apiPost('/pos/categories', { name:newCategory.name, icon:newCategory.icon||'📦', sortOrder: newCategory.sortOrder===''?0:Number(newCategory.sortOrder), propertyIds: newCategory.propertyIds }),
    { onSuccess: () => { invalCats(); setNewCategory({ name:'', icon:'📦', sortOrder:'', propertyIds:[] }) } }
  )
  const updateCategoryMut = useMutation(
    (data:any) => apiPatch(`/pos/categories/${editCategory.id}`, data),
    { onSuccess: () => { invalCats(); setEditCategory(null) } }
  )
  const toggleCategoryActiveMut = useMutation(
    ({ id, val }:{ id:string; val:boolean }) => apiPatch(`/pos/categories/${id}`, { isActive:val }),
    { onSuccess: invalCats }
  )

  const createTaxMut = useMutation(() => apiPost('/pos/tax-rates', { ...newTax, propertyId: newTax.propertyId || null, rate:Number(newTax.rate)/100, taxType:newTax.taxType, appliesTo:newTax.appliesTo==='all'?['all']:[newTax.appliesTo] }), { onSuccess: () => { qc.invalidateQueries('pos-tax-rates'); setNewTax({ name:'', rate:'', taxType:'state', appliesTo:'all', propertyId:'' }) } })
  const deleteTaxMut = useMutation((id:string) => apiDel(`/pos/tax-rates/${id}`), { onSuccess: () => qc.invalidateQueries('pos-tax-rates') })
  // Tax categories: add + edit-rate. Rates entered as % in the UI, stored as decimals.
  const [newTaxCat, setNewTaxCat] = useState({ name:'', ratePct:'' })
  const createTaxCatMut = useMutation(() => apiPost('/pos/tax-categories', { name:newTaxCat.name, rate:Number(newTaxCat.ratePct||0)/100 }), { onSuccess: () => { qc.invalidateQueries('pos-tax-categories'); setNewTaxCat({ name:'', ratePct:'' }) }, onError:(e:any)=>alert(e?.response?.data?.error?.message||e?.response?.data?.error||'Could not add tax category') })
  const updateTaxCatMut = useMutation((v:any) => apiPatch(`/pos/tax-categories/${v.id}`, { rate:v.rate, isActive:v.isActive }), { onSuccess: () => { qc.invalidateQueries('pos-tax-categories'); qc.invalidateQueries('pos-items') } })
  const createDiscountMut = useMutation(() => apiPost('/pos/discounts', { ...newDiscount, value:Number(newDiscount.value) }), { onSuccess: () => { qc.invalidateQueries('pos-discounts'); setNewDiscount({ name:'', type:'percent', value:'', code:'' }) } })
  const deleteDiscountMut = useMutation((id:string) => apiDel(`/pos/discounts/${id}`), { onSuccess: () => qc.invalidateQueries('pos-discounts') })
  const refundMut = useMutation(() => apiPost(`/pos/transactions/${refundModal.tx?.id}/refund`, { amount:Number(refundAmt)||refundModal.tx?.total, reason:refundReason, refundMethod }), { onSuccess: () => { qc.invalidateQueries('pos-transactions'); setRefundModal({show:false,tx:null}); setRefundAmt(''); setRefundReason(''); setRefundMethod('cash') } })
  const voidMut = useMutation((id:string) => apiPost(`/pos/transactions/${id}/void`, { reason:'Voided by cashier' }), { onSuccess: () => qc.invalidateQueries('pos-transactions') })

  // S243: SDK Bluetooth-reader discovery + connect (handheld path).
  // Smart readers (S700, WisePOS E) appear in the modal too but via
  // the `registeredReaders` GAM-side list, not the SDK scan.
  const discoverAndConnect = async () => {
    setTerminalStatus('discovering'); setTerminalError('')
    try { const found = await discoverReaders(); setReaders(found); setTerminalStatus('idle') }
    catch (e: any) { setTerminalError(e.message); setTerminalStatus('error') }
  }
  const selectBluetoothReader = async (reader: any) => {
    setTerminalStatus('connecting')
    try {
      const r = await connectReader(reader)
      setActiveReader({ type: 'bluetooth', sdkReader: r, label: r.label || r.serialNumber })
      setReaderModal(false); setTerminalStatus('idle')
    } catch (e: any) { setTerminalError(e.message); setTerminalStatus('error') }
  }
  const selectSmartReader = (r: RegisteredReader) => {
    setActiveReader({ type: 'smart', stripeReaderId: r.stripeReaderId, nickname: r.nickname })
    setReaderModal(false)
  }

  // S243: full card-present charge flow.
  // 1. Create PI on landlord's Connect account (server-side).
  // 2. Branch:
  //    - smart reader: push PI to reader, poll status until
  //      requires_capture / canceled / timeout.
  //    - bluetooth:    SDK collects card in-browser; SDK process
  //      returns the PI in requires_capture.
  // 3. Capture (server-side; flips PI to succeeded).
  // 4. POST /pos/transactions with stripePaymentIntentId — backend
  //    validates and persists.
  // 5. On any error, attempt PI cancel so it doesn't sit in
  //    requires_payment_method on the landlord's account.
  const chargeWithReader = async () => {
    if (!registerProperty) {
      setTerminalError('Select a property before charging')
      setTerminalStatus('error'); return
    }
    if (!activeReader) { setReaderModal(true); return }
    setTerminalStatus('collecting'); setTerminalError('')
    let piId: string | null = null
    try {
      const intent = await createTerminalIntent({
        amountCents: Math.round(total * 100),
        propertyId:  registerProperty,
        description: 'GAM POS sale',
      })
      piId = intent.id

      if (activeReader.type === 'smart') {
        await processIntentOnReader({
          paymentIntentId: intent.id,
          stripeReaderId:  activeReader.stripeReaderId,
        })
        await pollPiUntilTerminal(intent.id)
      } else {
        await collectCardPayment(intent.clientSecret)
      }

      setTerminalStatus('capturing')
      await captureTerminalIntent(intent.id)
      setTerminalStatus('idle')
      checkoutMut.mutate(intent.id)
    } catch (e: any) {
      setTerminalError(e?.response?.data?.error?.message || e?.message || 'Charge failed')
      setTerminalStatus('error')
      if (activeReader.type === 'bluetooth') {
        await cancelCurrentPayment().catch(() => {})
      }
      if (piId) {
        await cancelTerminalIntent(piId).catch(() => {})
      }
    }
  }

  // S243: Readers-tab mutations. Register-new + archive surface the
  // S241 backend CRUD so landlords can pair smart readers without
  // hitting the API directly.
  const registerReaderMut = useMutation(
    () => registerNewReader(newReader),
    { onSuccess: () => {
      qc.invalidateQueries('pos-terminal-readers')
      setNewReader({ propertyId:'', registrationCode:'', nickname:'' })
    }},
  )
  const archiveReaderMut = useMutation(
    (id: string) => archiveRegisteredReader(id),
    { onSuccess: () => qc.invalidateQueries('pos-terminal-readers') },
  )

  const TABS = [
    { key:'register',  label:'Register' },
    { key:'history',   label:'History' },
    { key:'items',     label:'Items' },
    { key:'categories',label:'Categories' },
    { key:'taxes',     label:'Tax Rates' },
    { key:'discounts', label:'Discounts' },
    { key:'vendors',   label:'Vendors' },
    { key:'orders',    label:'Orders' },
    { key:'inventory', label:'Inventory' },
    { key:'readers',   label:'Readers' },
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
            {receipt.surcharge>0&&<div style={{display:'flex',justifyContent:'space-between'}}><span style={{color:'var(--text-3)'}}>Card surcharge</span><span>{fmt(receipt.surcharge)}</span></div>}
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
        <div><h1 className="page-title">Point of Sale</h1></div>
        <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
          {TABS.map(t => <button key={t.key} className={"tab-btn "+(tab===t.key?'active':'')} onClick={()=>setTab(t.key as any)}>{t.label}</button>)}
        </div>
      </div>

      {tab==='register' && (
        <div style={{display:'grid',gridTemplateColumns:'1fr 340px',gap:16,alignItems:'start'}}>
          <div>
            {/* Register/property picker — you must choose which property you're
                ringing on before adding items (items, tax, and sessions are all
                per property). Single-property operators are auto-selected. */}
            {(properties as any[]).length > 1 && (
              <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:12}}>
                <label style={{fontSize:'.78rem',color:'var(--text-3)'}}>Register:</label>
                <select className="form-select" value={registerProperty} onChange={e=>{ setRegisterProperty(e.target.value); setTenantId(''); setPosCustomerId('') }} style={{width:'auto',minWidth:220}}>
                  <option value="" disabled>Select a property…</option>
                  {(properties as any[]).map((p:any)=><option key={p.id} value={p.id}>{p.name||p.street1}</option>)}
                </select>
              </div>
            )}
            {!registerProperty ? (
              <div style={{padding:'48px 24px',textAlign:'center',color:'var(--text-3)',border:'1px dashed var(--border-1)',borderRadius:12}}>
                Select a property above to start ringing up sales.
              </div>
            ) : (<>
            {/* S263: open-tab banner — appears when there's an unclosed
                session on this property from a prior terminal visit /
                crash / handoff. Resume loads the items; Discard voids. */}
            {openTabBanner && cart.length === 0 && (
              <div style={{display:'flex',alignItems:'center',gap:12,padding:'12px 16px',background:'rgba(201,162,39,.08)',border:'1px solid rgba(201,162,39,.3)',borderRadius:10,marginBottom:12}}>
                <div style={{flex:1}}>
                  <div style={{fontWeight:700,color:'var(--gold)',fontSize:'.85rem',marginBottom:2}}>Open tab on this register</div>
                  <div style={{fontSize:'.75rem',color:'var(--text-2)'}}>
                    {openTabBanner.itemCount} item{openTabBanner.itemCount===1?'':'s'} · {fmt(openTabBanner.total)} · opened {openTabBanner.openedAt ? new Date(openTabBanner.openedAt).toLocaleTimeString() : 'earlier'}
                  </div>
                </div>
                <button onClick={()=>resumeSession(openTabBanner.id)} className="btn btn-primary btn-sm">Resume</button>
                <button onClick={()=>discardOpenTab(openTabBanner.id)} className="btn btn-ghost btn-sm">Discard</button>
              </div>
            )}
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
            </>)}
          </div>
          <div className="card" style={{position:'sticky',top:80}}>
            <div className="card-header"><span className="card-title">Current Sale</span>
              {cart.length>0&&<button onClick={() => {
                // S263/S264: clearing the cart enqueues a void on the
                // live session. Offline-tolerant — drains on reconnect.
                if (clientSessionId) {
                  void enqueueSync({
                    op: 'VOID_SESSION',
                    clientSessionId,
                    payload: { reason: 'cleared_by_cashier' },
                  })
                  qc.invalidateQueries(['pos-sessions-open', registerProperty])
                }
                setClientSessionId(null); setCart([])
              }} style={{background:'none',border:'none',color:'var(--text-3)',cursor:'pointer',fontSize:'.75rem'}}>Clear</button>}
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
              {surcharge>0&&<div style={{display:'flex',justifyContent:'space-between'}}><span style={{color:'var(--text-3)'}}>Card surcharge (1%)</span><span>{fmt(surcharge)}</span></div>}
              <div style={{display:'flex',justifyContent:'space-between',fontWeight:700,fontSize:'.95rem',borderTop:'1px solid var(--border-1)',paddingTop:6,marginTop:2}}>
                <span>Total</span><span style={{color:'var(--gold)'}}>{fmt(total)}</span>
              </div>
            </div>
            <div style={{marginBottom:10}}>
              <div style={{fontSize:'.72rem',color:'var(--text-3)',marginBottom:5}}>Payment method</div>
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:5}}>
                {(['cash','card','charge'] as const).filter(m=>!(LAUNCH_HIDE_CHARGE && m==='charge')).map(m=>(<button key={m} onClick={()=>setMethod(m)} style={{padding:'7px 0',border:"1px solid "+(method===m?'var(--gold)':'var(--border-1)'),background:method===m?'var(--gold-bg)':'var(--bg-2)',borderRadius:'var(--r-md)',cursor:'pointer',fontSize:'.75rem',fontWeight:method===m?700:400,color:method===m?'var(--gold)':'var(--text-2)',textTransform:'capitalize'}}>{m==='charge'?'charge':m}</button>))}
              </div>
            </div>
            {method==='cash'&&(<div style={{marginBottom:10}}>
              <input className="form-input" type="number" placeholder="Cash given" value={cashGiven} onChange={e=>setCashGiven(e.target.value)} style={{width:'100%'}} />
              {cashGiven&&Number(cashGiven)>=total&&<div style={{fontSize:'.82rem',color:'var(--green)',fontWeight:600,marginTop:4}}>Change: {fmt(changeDue)}</div>}
            </div>)}
            {method==='charge'&&(<div style={{marginBottom:10,display:'grid',gap:6}}>
              {/* S254: FlexCharge property selector — accounts are
                  per-property. Auto-picks for single-property landlords. */}
              {(properties as any[]).length>1&&(
                <select className="form-select" value={registerProperty} onChange={e=>{ setRegisterProperty(e.target.value); setTenantId(''); setPosCustomerId('') }} style={{width:'100%'}}>
                  <option value="">Select property...</option>
                  {(properties as any[]).map((p:any)=><option key={p.id} value={p.id}>{p.name||p.address1||p.id}</option>)}
                </select>
              )}
              {/* Customer type toggle */}
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:5}}>
                {(['tenant','pos_customer'] as const).map(t=>(
                  <button key={t} type="button" onClick={()=>{ setChargeCustomerType(t); setTenantId(''); setPosCustomerId('') }} style={{padding:'5px 0',border:'1px solid '+(chargeCustomerType===t?'var(--gold)':'var(--border-1)'),background:chargeCustomerType===t?'var(--gold-bg)':'var(--bg-2)',borderRadius:'var(--r-md)',cursor:'pointer',fontSize:'.72rem',color:chargeCustomerType===t?'var(--gold)':'var(--text-2)',fontWeight:chargeCustomerType===t?600:400}}>{t==='tenant'?'Tenant':'POS Customer'}</button>
                ))}
              </div>
              {/* Customer picker */}
              {chargeCustomerType==='tenant'?(
                <select className="form-select" value={tenantId} onChange={e=>setTenantId(e.target.value)} style={{width:'100%'}}>
                  <option value="">Select tenant...</option>
                  {(tenants as any[]).map((t:any)=><option key={t.id} value={t.id}>{t.firstName} {t.lastName}</option>)}
                </select>
              ):(
                <select className="form-select" value={posCustomerId} onChange={e=>setPosCustomerId(e.target.value)} style={{width:'100%'}}>
                  <option value="">Select customer...</option>
                  {(posCustomers as any[]).map((c:any)=><option key={c.id} value={c.id}>{c.firstName} {c.lastName} — {c.email}</option>)}
                </select>
              )}
              {chargeBlocked&&<div style={{fontSize:'.72rem',color:'var(--red)'}}>Cart has non-charge-eligible items</div>}
            </div>)}
            {/* S243: card-method property + reader controls. Auto-hidden
                for single-property landlords (auto-picked on load); only
                shows the picker when the landlord owns 2+ properties. */}
            {method==='card'&&(<div style={{marginBottom:10,display:'grid',gap:6}}>
              {(properties as any[]).length>1&&(
                <select className="form-select" value={registerProperty} onChange={e=>{ setRegisterProperty(e.target.value); setActiveReader(null) }} style={{width:'100%'}}>
                  <option value="">Select property...</option>
                  {(properties as any[]).map((p:any)=><option key={p.id} value={p.id}>{p.name||p.address1||p.id}</option>)}
                </select>
              )}
              <button type="button" className="btn btn-ghost btn-sm" onClick={()=>setReaderModal(true)} style={{width:'100%',justifyContent:'space-between',display:'flex'}}>
                <span style={{color:'var(--text-3)'}}>Reader</span>
                <span style={{color:activeReader?'var(--gold)':'var(--text-3)'}}>
                  {activeReader ? (activeReader.type==='smart' ? activeReader.nickname : activeReader.label) : 'Select…'}
                </span>
              </button>
              {terminalStatus==='collecting'&&<div style={{fontSize:'.72rem',color:'var(--text-3)'}}>Waiting for customer at reader…</div>}
              {terminalStatus==='capturing'&&<div style={{fontSize:'.72rem',color:'var(--text-3)'}}>Capturing payment…</div>}
              {terminalStatus==='error'&&terminalError&&<div style={{fontSize:'.72rem',color:'var(--red)'}}>{terminalError}</div>}
            </div>)}
            <button className="btn btn-primary" style={{width:'100%'}} disabled={
              cart.length===0
              || checkoutMut.isLoading
              || terminalStatus==='collecting'
              || terminalStatus==='capturing'
              || (method==='charge' && (chargeBlocked || !registerProperty || (chargeCustomerType==='tenant' ? !tenantId : !posCustomerId)))
              || (method==='card' && !registerProperty)
            } onClick={()=>method==='card'?chargeWithReader():checkoutMut.mutate(undefined)}>
              {checkoutMut.isLoading?'Processing...':terminalStatus==='collecting'?'Awaiting card…':terminalStatus==='capturing'?'Capturing…':'Charge '+fmt(total)}
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
            <div className="card-header" style={{display:'flex',justifyContent:'space-between',alignItems:'center',flexWrap:'wrap',gap:8}}>
              <span className="card-title">Add Item</span>
              <div style={{display:'flex',alignItems:'center',gap:6}}>
                <span style={{fontSize:'.72rem',color:'var(--text-3)'}}>Default margin %</span>
                <input className="form-input" type="number" style={{width:80}} value={marginEdit}
                  placeholder={defaultMarginPct!=null?String(defaultMarginPct):'none'}
                  onChange={e=>setMarginEdit(e.target.value)} />
                <button className="btn btn-ghost btn-sm" disabled={saveMarginMut.isLoading}
                  onClick={()=>saveMarginMut.mutate(marginEdit)}>Save</button>
              </div>
            </div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:12,marginTop:12}}>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Icon</div><select className="form-select" value={newItem.icon} onChange={e=>setNewItem(s=>({...s,icon:e.target.value}))} style={{width:'100%'}}>{POS_ICON_OPTIONS.map(ic=><option key={ic} value={ic}>{ic}</option>)}</select></div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Name</div><input className="form-input" value={newItem.name} onChange={e=>setNewItem(s=>({...s,name:e.target.value}))} style={{width:'100%'}} /></div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Category</div><select className="form-select" value={newItem.categoryId} onChange={e=>setNewItem(s=>({...s,categoryId:e.target.value}))} style={{width:'100%'}}>{categoriesForProperty(newItem.propertyId).map(c=><option key={c.id} value={c.id}>{c.icon} {c.name}</option>)}</select></div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Cost Price</div><input className="form-input" type="number" value={newItem.costPrice} onChange={e=>setItemCost(e.target.value)} style={{width:'100%'}} /></div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Margin %{defaultMarginPct!=null?` (default ${defaultMarginPct})`:''}</div><input className="form-input" type="number" value={newItem.marginPct} onChange={e=>setItemMargin(e.target.value)} placeholder={defaultMarginPct!=null?String(defaultMarginPct):'—'} style={{width:'100%'}} /></div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Sell Price{newItem.costPrice&&newItem.marginPct?' (auto)':''}</div><input className="form-input" type="number" value={newItem.sellPrice} onChange={e=>setItemSell(e.target.value)} style={{width:'100%'}} /></div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Tax Category</div><select className="form-select" value={newItem.taxCategoryId} onChange={e=>setNewItem(s=>({...s,taxCategoryId:e.target.value}))} style={{width:'100%'}}><option value="">— none (0%) —</option>{(posTaxCategories as any[]).map((t:any)=><option key={t.id} value={t.id}>{t.name} ({(Number(t.rate)*100).toFixed(2)}%)</option>)}</select></div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Stock Qty</div><input className="form-input" type="number" value={newItem.stockQty} onChange={e=>setNewItem(s=>({...s,stockQty:e.target.value}))} style={{width:'100%'}} /></div>
              {!LAUNCH_HIDE_CHARGE && <div style={{display:'flex',alignItems:'center',gap:8,paddingTop:20}}><input type="checkbox" id="ce" checked={newItem.chargeEligible} onChange={e=>setNewItem(s=>({...s,chargeEligible:e.target.checked}))} /><label htmlFor="ce" style={{fontSize:'.82rem'}}>Charge eligible</label></div>}
              {/* S192: property selector. Empty = company-wide. */}
              <div style={{gridColumn:'span 2'}}>
                <div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>
                  Property <span style={{color:'var(--text-3)'}}>(low-stock alerts route to this property's manager)</span>
                </div>
                <select
                  className="form-select"
                  value={newItem.propertyId}
                  onChange={e=>setNewItem(s=>({...s,propertyId:e.target.value}))}
                  style={{width:'100%'}}
                >
                  <option value="" disabled>Select a property…</option>
                  {(properties as any[]).map((p:any)=>(
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>
            </div>
            <button className="btn btn-primary" style={{marginTop:12}} onClick={submitNewItem} disabled={!newItem.name||!newItem.sellPrice||!newItem.categoryId||!newItem.propertyId||createItemMut.isLoading}>{createItemMut.isLoading?'Adding…':'Add Item'}</button>
          </div>
          {/* S216: property filter for the items management list.
              Default 'all' shows everything; 'company-wide' shows only
              NULL-property_id items; specific uuid scopes to one property. */}
          <div style={{display:'flex',alignItems:'center',gap:8,padding:'4px 4px 0'}}>
            <label style={{fontSize:'.78rem',color:'var(--text-3)',marginBottom:0}}>Filter by property:</label>
            <select
              className="form-select"
              value={filterItemProperty}
              onChange={e=>setFilterItemProperty(e.target.value)}
              style={{width:'auto',padding:'4px 10px',fontSize:'.82rem'}}
            >
              <option value="all">All ({(items as any[]).length})</option>
              <option value="company-wide">
                Company-wide ({(items as any[]).filter((i:any)=>!i.propertyId).length})
              </option>
              {(properties as any[]).map((p:any)=>{
                const n = (items as any[]).filter((i:any)=>i.propertyId===p.id).length
                return <option key={p.id} value={p.id}>{p.name} ({n})</option>
              })}
            </select>
          </div>
          <div className="card" style={{padding:0}}>
            <table className="data-table">
              <thead><tr>
                <th style={{cursor:'pointer',userSelect:'none'}} onClick={()=>toggleItemSort('name')}>Item {itemSort.key==='name'?(itemSort.dir==='asc'?'▲':'▼'):''}</th>
                <th style={{cursor:'pointer',userSelect:'none'}} onClick={()=>toggleItemSort('category')}>Category {itemSort.key==='category'?(itemSort.dir==='asc'?'▲':'▼'):''}</th>
                <th style={{cursor:'pointer',userSelect:'none'}} onClick={()=>toggleItemSort('property')}>Property {itemSort.key==='property'?(itemSort.dir==='asc'?'▲':'▼'):''}</th>
                <th>Cost</th>
                <th style={{cursor:'pointer',userSelect:'none'}} onClick={()=>toggleItemSort('price')}>Price {itemSort.key==='price'?(itemSort.dir==='asc'?'▲':'▼'):''}</th>
                <th>Tax</th>
                <th style={{cursor:'pointer',userSelect:'none'}} onClick={()=>toggleItemSort('stock')}>Stock {itemSort.key==='stock'?(itemSort.dir==='asc'?'▲':'▼'):''}</th>
                {!LAUNCH_HIDE_CHARGE && <th>Charge</th>}
                <th>Active</th>
                <th></th>
              </tr></thead>
              <tbody>
                {(items as any[])
                  .filter((i:any) =>
                    filterItemProperty === 'all' ||
                    (filterItemProperty === 'company-wide' && !i.propertyId) ||
                    i.propertyId === filterItemProperty
                  )
                  .sort((a:any,b:any)=>{
                    const propLabel=(i:any)=>{ const p=i.propertyId?(properties as any[]).find((x:any)=>x.id===i.propertyId):null; return p?(p.street1||p.name||''):(posSettings?.businessName||'') }
                    let av:any, bv:any
                    if(itemSort.key==='name'){av=a.name||'';bv=b.name||''}
                    else if(itemSort.key==='category'){av=a.category||'';bv=b.category||''}
                    else if(itemSort.key==='property'){av=propLabel(a);bv=propLabel(b)}
                    else if(itemSort.key==='price'){av=Number(a.sellPrice)||0;bv=Number(b.sellPrice)||0}
                    else {av=Number(a.stockQty)||0;bv=Number(b.stockQty)||0}
                    const cmp = (typeof av==='number'&&typeof bv==='number') ? (av-bv) : String(av).localeCompare(String(bv),undefined,{numeric:true,sensitivity:'base'})
                    return itemSort.dir==='asc'?cmp:-cmp
                  })
                  .map((item:any)=>{
                  const iprop = item.propertyId ? (properties as any[]).find((p:any)=>p.id===item.propertyId) : null
                  const ipropAddr = iprop ? (iprop.street1 || iprop.name || '(unknown)') : null
                  return (<tr key={item.id}>
                  <td style={{fontWeight:500}}>{item.icon} {item.name}</td>
                  <td><span className="badge badge-muted">{item.category}</span></td>
                  <td>{ipropAddr
                    ? <span style={{color:'var(--gold)',fontWeight:500,fontSize:'.78rem'}}>{ipropAddr}</span>
                    : <span style={{color:'var(--text-3)',fontSize:'.78rem'}}>{posSettings?.businessName || 'Company-wide'}</span>
                  }</td>
                  <td className="mono">{fmt(item.costPrice)}</td>
                  <td className="mono" style={{color:'var(--gold)',fontWeight:600}}>{fmt(item.sellPrice)}</td>
                  <td className="mono">{pct(item.taxRate)}</td>
                  <td className="mono">{item.stockQty>=999?'inf':item.stockQty}</td>
                  {!LAUNCH_HIDE_CHARGE && <td><button onClick={()=>toggleChargeMut.mutate({id:item.id,val:!item.chargeEligible})} style={{background:item.chargeEligible?'var(--gold-bg)':'var(--bg-3)',border:"1px solid "+(item.chargeEligible?'var(--gold)':'var(--border-1)'),borderRadius:4,padding:'2px 8px',cursor:'pointer',fontSize:'.75rem',color:item.chargeEligible?'var(--gold)':'var(--text-3)'}}>{item.chargeEligible?'Yes':'No'}</button></td>}
                  <td><button onClick={()=>toggleActiveMut.mutate({id:item.id,val:!item.isActive})} style={{background:'var(--bg-2)',border:'1px solid var(--border-1)',borderRadius:4,padding:'2px 8px',cursor:'pointer',fontSize:'.75rem',color:item.isActive?'var(--green)':'var(--text-3)'}}>{item.isActive?'Active':'Off'}</button></td>
                  <td><button className="btn btn-ghost btn-sm" onClick={()=>setEditItem({...item,_sell:String(item.sellPrice),_cost:String(item.costPrice),_taxCategoryId:item.taxCategoryId||'',_stock:String(item.stockQty),_min:String(item.stockMin),_max:String(item.stockMax)})}>Edit</button></td>
                </tr>)})}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab==='categories' && (
        <div style={{display:'grid',gap:16}}>
          <div className="card">
            <div className="card-header"><span className="card-title">Add Category</span></div>
            <div style={{display:'grid',gridTemplateColumns:'80px 1fr auto',gap:12,marginTop:12,alignItems:'end'}}>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Icon</div><select className="form-select" value={newCategory.icon} onChange={e=>setNewCategory(s=>({...s,icon:e.target.value}))} style={{width:'100%'}}>{POS_ICON_OPTIONS.map(ic=><option key={ic} value={ic}>{ic}</option>)}</select></div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Name *</div><input className="form-input" placeholder="Snacks" value={newCategory.name} onChange={e=>setNewCategory(s=>({...s,name:e.target.value}))} style={{width:'100%'}} /></div>
              <button className="btn btn-primary" onClick={()=>createCategoryMut.mutate()} disabled={!newCategory.name||createCategoryMut.isLoading}>{createCategoryMut.isLoading?'Adding...':'Add'}</button>
            </div>
            {/* Property scope — opens a popup picker (clearer than inline).
                "All properties" (empty) = company-wide; else the chosen subset. */}
            <div style={{marginTop:12}}>
              <div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:6}}>Available at</div>
              <button type="button" className="form-select" onClick={()=>setShowCatPropPicker(true)}
                style={{width:'100%',textAlign:'left',cursor:'pointer',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                <span>{newCategory.propertyIds.length===0
                  ? 'All properties'
                  : newCategory.propertyIds.length===1
                    ? ((properties as any[]).find((p:any)=>p.id===newCategory.propertyIds[0])?.name || '1 property')
                    : `${newCategory.propertyIds.length} properties`}</span>
                <span style={{color:'var(--text-3)'}}>▾</span>
              </button>
            </div>
            <div style={{fontSize:'.72rem',color:'var(--text-3)',marginTop:8}}>
              Categories appear in the Add/Edit Item dropdown and the tax-rate Applies-To dropdown. Click the Name or Property column header below to sort. Inactive categories stay attached to existing items but won't appear in dropdowns.
            </div>
          </div>
          {/* S220: list filter mirrors the items + tax-rates property filters. */}
          <div style={{display:'flex',alignItems:'center',gap:8,padding:'4px 4px 0'}}>
            <label style={{fontSize:'.78rem',color:'var(--text-3)',marginBottom:0}}>Filter by property:</label>
            <select className="form-select" value={filterCategoryProperty} onChange={e=>setFilterCategoryProperty(e.target.value)} style={{width:'auto',padding:'4px 10px',fontSize:'.82rem'}}>
              <option value="all">All ({(posCategoriesAll as any[]).length})</option>
              <option value="company-wide">Company-wide ({(posCategoriesAll as any[]).filter((c:any)=>!c.propertyIds?.length).length})</option>
              {(properties as any[]).map((p:any)=>{
                const n = (posCategoriesAll as any[]).filter((c:any)=>!c.propertyIds?.length || c.propertyIds.includes(p.id)).length
                return <option key={p.id} value={p.id}>{p.name} ({n})</option>
              })}
            </select>
          </div>
          <div className="card" style={{padding:0}}>
            <table className="data-table">
              <thead><tr>
                <th style={{width:60}}>Icon</th>
                <th style={{cursor:'pointer',userSelect:'none'}} onClick={()=>toggleCatSort('name')}>Name {catSort.key==='name' ? (catSort.dir==='asc'?'▲':'▼') : ''}</th>
                <th style={{cursor:'pointer',userSelect:'none'}} onClick={()=>toggleCatSort('property')}>Property {catSort.key==='property' ? (catSort.dir==='asc'?'▲':'▼') : ''}</th>
                <th style={{width:80}}>Items</th>
                <th style={{width:90}}>Status</th>
                <th style={{width:80}}></th>
              </tr></thead>
              <tbody>
                {(() => {
                  const filtered = (posCategoriesAll as any[]).filter((c:any) => {
                    if (filterCategoryProperty === 'all') return true
                    const ids = c.propertyIds as string[] | null | undefined
                    if (filterCategoryProperty === 'company-wide') return !ids || ids.length === 0
                    // A specific property shows categories available there:
                    // company-wide ones plus any scoped to include it.
                    return !ids || ids.length === 0 || ids.includes(filterCategoryProperty)
                  })
                  // Scope label for the Property column + sort. Company-wide →
                  // business name; one property → its address; many → "N properties".
                  const catScopeLabel = (c:any): { text: string; scoped: boolean } => {
                    const ids = c.propertyIds as string[] | null | undefined
                    if (!ids || ids.length === 0) return { text: posSettings?.businessName || 'Company-wide', scoped: false }
                    if (ids.length === 1) { const p = (properties as any[]).find((x:any)=>x.id===ids[0]); return { text: p ? (p.street1||p.name||'(unknown)') : '(unknown)', scoped: true } }
                    return { text: `${ids.length} properties`, scoped: true }
                  }
                  const sorted = [...filtered].sort((a:any,b:any) => {
                    const av = catSort.key==='name' ? (a.name||'') : catScopeLabel(a).text
                    const bv = catSort.key==='name' ? (b.name||'') : catScopeLabel(b).text
                    const cmp = String(av).localeCompare(String(bv), undefined, { numeric:true, sensitivity:'base' })
                    return catSort.dir==='asc' ? cmp : -cmp
                  })
                  return sorted.length ? sorted.map((c:any) => {
                    const itemCount = (items as any[]).filter((i:any) => i.categoryId === c.id).length
                    // Property column shows where the category is available:
                    // company-wide → business name; else the address (1) or count.
                    const scope = catScopeLabel(c)
                    return (<tr key={c.id}>
                      <td style={{fontSize:'1.2rem'}}>{c.icon || '📦'}</td>
                      <td style={{fontWeight:500}}>{c.name}</td>
                      <td><span style={{color:scope.scoped?'var(--gold)':'var(--text-3)',fontWeight:scope.scoped?500:400,fontSize:'.78rem'}}>{scope.text}</span></td>
                      <td className="mono" style={{color:'var(--text-3)'}}>{itemCount}</td>
                      <td><button onClick={()=>toggleCategoryActiveMut.mutate({id:c.id,val:!c.isActive})} style={{background:'var(--bg-2)',border:'1px solid var(--border-1)',borderRadius:4,padding:'2px 8px',cursor:'pointer',fontSize:'.75rem',color:c.isActive?'var(--green)':'var(--text-3)'}}>{c.isActive?'Active':'Off'}</button></td>
                      <td><button className="btn btn-ghost btn-sm" onClick={()=>setEditCategory({...c, _name:c.name, _icon:c.icon||'📦', _sort:String(c.sortOrder ?? 0), _propertyIds: Array.isArray(c.propertyIds) ? c.propertyIds : []})}>Edit</button></td>
                    </tr>)
                  }) : <tr><td colSpan={6} style={{textAlign:'center',color:'var(--text-3)',padding:32}}>{(posCategoriesAll as any[]).length ? 'No categories at this property scope.' : 'Loading…'}</td></tr>
                })()}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab==='taxes' && (
        <div style={{display:'grid',gap:16}}>
          <div className="card">
            <div className="card-header"><span className="card-title">Tax Categories</span></div>
            <div style={{fontSize:'.72rem',color:'var(--text-3)',margin:'4px 0 10px'}}>Set one rate per category. Items pick a tax category and use its rate — no need to type tax on each item.</div>
            <table className="data-table">
              <thead><tr><th>Category</th><th style={{width:150}}>Rate %</th><th style={{width:90}}>Status</th></tr></thead>
              <tbody>
                {(posTaxCategories as any[]).map((t:any)=>(
                  <tr key={t.id}>
                    <td style={{fontWeight:500}}>{t.name}</td>
                    <td><input className="form-input" type="number" step="0.01" key={t.rate} defaultValue={(Number(t.rate)*100).toFixed(2)} onBlur={e=>{const v=Number(e.target.value)/100; if(v!==Number(t.rate)) updateTaxCatMut.mutate({id:t.id,rate:v})}} style={{width:100}} /></td>
                    <td><button onClick={()=>updateTaxCatMut.mutate({id:t.id,isActive:!t.isActive})} style={{background:'var(--bg-2)',border:'1px solid var(--border-1)',borderRadius:4,padding:'2px 8px',cursor:'pointer',fontSize:'.75rem',color:t.isActive?'var(--green)':'var(--text-3)'}}>{t.isActive?'Active':'Off'}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{display:'flex',gap:8,marginTop:12,alignItems:'center'}}>
              <input className="form-input" placeholder="New tax category (e.g. Candy)" value={newTaxCat.name} onChange={e=>setNewTaxCat(s=>({...s,name:e.target.value}))} style={{flex:1}} />
              <input className="form-input" type="number" step="0.01" placeholder="Rate %" value={newTaxCat.ratePct} onChange={e=>setNewTaxCat(s=>({...s,ratePct:e.target.value}))} style={{width:110}} />
              <button className="btn btn-primary" onClick={()=>createTaxCatMut.mutate()} disabled={!newTaxCat.name||createTaxCatMut.isLoading}>{createTaxCatMut.isLoading?'Adding…':'Add'}</button>
            </div>
          </div>
          <div className="card">
            <div className="card-header"><span className="card-title">Add Tax Rate</span></div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:12,marginTop:12}}>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Name</div><input className="form-input" placeholder="State Tax" value={newTax.name} onChange={e=>setNewTax(s=>({...s,name:e.target.value}))} style={{width:'100%'}} /></div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Rate %</div><input className="form-input" type="number" value={newTax.rate} onChange={e=>setNewTax(s=>({...s,rate:e.target.value}))} style={{width:'100%'}} /></div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Type</div><select className="form-select" value={newTax.taxType} onChange={e=>setNewTax(s=>({...s,taxType:e.target.value}))} style={{width:'100%'}}>{TAX_TYPES.map(t=><option key={t} value={t}>{t}</option>)}</select></div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Applies To</div><select className="form-select" value={newTax.appliesTo} onChange={e=>setNewTax(s=>({...s,appliesTo:e.target.value}))} style={{width:'100%'}}><option value="all">All categories</option>{categoriesForProperty(newTax.propertyId).map(c=><option key={c.name} value={c.name}>{c.icon} {c.name}</option>)}</select></div>
              {/* S217: property selector. Empty = company-wide library. */}
              <div style={{gridColumn:'span 2'}}>
                <div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>
                  Property <span style={{color:'var(--text-3)'}}>(scopes which properties this rate is configured at)</span>
                </div>
                <select className="form-select" value={newTax.propertyId} onChange={e=>setNewTax(s=>({...s,propertyId:e.target.value}))} style={{width:'100%'}}>
                  <option value="">All locations</option>
                  {(properties as any[]).map((p:any)=>(<option key={p.id} value={p.id}>{p.name}</option>))}
                </select>
              </div>
            </div>
            <button className="btn btn-primary" style={{marginTop:12}} onClick={()=>createTaxMut.mutate()} disabled={!newTax.name||!newTax.rate}>Add Rate</button>
          </div>
          {/* S217: tax-rate list filter mirrors the items-tab S216 filter. */}
          <div style={{display:'flex',alignItems:'center',gap:8,padding:'4px 4px 0'}}>
            <label style={{fontSize:'.78rem',color:'var(--text-3)',marginBottom:0}}>Filter by property:</label>
            <select className="form-select" value={filterTaxProperty} onChange={e=>setFilterTaxProperty(e.target.value)} style={{width:'auto',padding:'4px 10px',fontSize:'.82rem'}}>
              <option value="all">All ({(taxRates as any[]).length})</option>
              <option value="company-wide">All locations ({(taxRates as any[]).filter((r:any)=>!r.propertyId).length})</option>
              {(properties as any[]).map((p:any)=>{
                const n = (taxRates as any[]).filter((r:any)=>r.propertyId===p.id).length
                return <option key={p.id} value={p.id}>{p.name} ({n})</option>
              })}
            </select>
          </div>
          <div className="card" style={{padding:0}}>
            <table className="data-table">
              <thead><tr><th>Name</th><th>Type</th><th>Property</th><th>Rate</th><th>Applies To</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {(() => {
                  const filtered = (taxRates as any[]).filter((r:any) =>
                    filterTaxProperty === 'all' ||
                    (filterTaxProperty === 'company-wide' && !r.propertyId) ||
                    r.propertyId === filterTaxProperty
                  )
                  return filtered.length ? filtered.map((r:any)=>{
                    const propName = r.propertyId
                      ? (properties as any[]).find((p:any)=>p.id===r.propertyId)?.name ?? '(unknown)'
                      : null
                    return (<tr key={r.id}>
                      <td style={{fontWeight:500}}>{r.name}</td><td><span className="badge badge-muted">{r.taxType}</span></td>
                      <td>{propName
                        ? <span style={{color:'var(--gold)',fontWeight:500,fontSize:'.78rem'}}>{propName}</span>
                        : <span style={{color:'var(--text-3)',fontStyle:'italic',fontSize:'.78rem'}}>All locations</span>
                      }</td>
                      <td className="mono">{pct(r.rate)}</td>
                      <td style={{fontSize:'.82rem'}}>{Array.isArray(r.appliesTo)?r.appliesTo.join(', '):r.appliesTo}</td>
                      <td><span className={"badge "+(r.isActive?'badge-green':'badge-red')}>{r.isActive?'active':'inactive'}</span></td>
                      <td><button className="btn btn-ghost btn-sm" style={{color:'var(--red)'}} onClick={()=>deleteTaxMut.mutate(r.id)}>Remove</button></td>
                    </tr>)
                  }) : <tr><td colSpan={7} style={{textAlign:'center',color:'var(--text-3)',padding:32}}>No tax rates configured.</td></tr>
                })()}
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

      {/* S243: Readers tab — pair / list / archive smart readers (S700,
          WisePOS E, etc.). Smart readers are bound to a property and
          surfaced in the charge modal when that property is selected.
          Bluetooth handheld readers don't appear here — they're paired
          via the JS SDK at charge time. */}
      {tab==='readers' && (
        <div style={{display:'grid',gap:16}}>
          <div className="card">
            <div className="card-header"><span className="card-title">Pair New Smart Reader</span></div>
            <div style={{fontSize:'.78rem',color:'var(--text-3)',marginTop:8,marginBottom:12}}>
              Put the reader in pairing mode (Settings → Generate Pairing Code on the device).
              Enter the code shown on the reader's screen below.
            </div>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:12,alignItems:'end'}}>
              <div>
                <div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Property</div>
                <select className="form-select" value={newReader.propertyId} onChange={e=>setNewReader(s=>({...s,propertyId:e.target.value}))} style={{width:'100%'}}>
                  <option value="">Select…</option>
                  {(properties as any[]).map((p:any)=><option key={p.id} value={p.id}>{p.name||p.address1||p.id}</option>)}
                </select>
              </div>
              <div>
                <div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Pairing code</div>
                <input className="form-input" value={newReader.registrationCode} onChange={e=>setNewReader(s=>({...s,registrationCode:e.target.value}))} style={{width:'100%'}} placeholder="e.g. cute-cat-purple" />
              </div>
              <div>
                <div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Nickname</div>
                <input className="form-input" value={newReader.nickname} onChange={e=>setNewReader(s=>({...s,nickname:e.target.value}))} style={{width:'100%'}} placeholder="e.g. Front office S700" />
              </div>
              <div style={{gridColumn:'1/-1'}}>
                <button
                  className="btn btn-primary"
                  style={{width:'100%'}}
                  onClick={()=>registerReaderMut.mutate()}
                  disabled={!newReader.propertyId||!newReader.registrationCode||!newReader.nickname||registerReaderMut.isLoading}
                >
                  {registerReaderMut.isLoading?'Pairing…':'Pair Reader'}
                </button>
                {registerReaderMut.isError&&<div style={{fontSize:'.75rem',color:'var(--red)',marginTop:6}}>{(registerReaderMut.error as any)?.response?.data?.error?.message||'Pairing failed'}</div>}
              </div>
            </div>
          </div>

          <div className="card" style={{padding:0}}>
            <div className="card-header" style={{padding:'16px 20px'}}>
              <span className="card-title">Active Readers</span>
              <span style={{fontSize:'.75rem',color:'var(--text-3)'}}>{(registeredReaders as RegisteredReader[]).length} reader(s)</span>
            </div>
            <table className="data-table">
              <thead><tr><th>Nickname</th><th>Property</th><th>Stripe ID</th><th>Registered</th><th></th></tr></thead>
              <tbody>
                {(registeredReaders as RegisteredReader[]).length?(registeredReaders as RegisteredReader[]).map(r=>{
                  const prop = (properties as any[]).find((p:any)=>p.id===r.propertyId)
                  return (
                    <tr key={r.id}>
                      <td style={{fontWeight:500}}>{r.nickname}</td>
                      <td style={{color:'var(--text-3)',fontSize:'.82rem'}}>{prop?.name||prop?.address1||r.propertyId}</td>
                      <td className="mono" style={{fontSize:'.75rem',color:'var(--text-3)'}}>{r.stripeReaderId}</td>
                      <td className="mono" style={{fontSize:'.78rem',color:'var(--text-3)'}}>{new Date(r.registeredAt).toLocaleDateString()}</td>
                      <td>
                        <button
                          className="btn btn-ghost btn-sm"
                          style={{color:'var(--red)'}}
                          onClick={()=>{ if(confirm('Archive '+r.nickname+'? It will no longer appear in the charge modal.')) archiveReaderMut.mutate(r.id) }}
                        >Archive</button>
                      </td>
                    </tr>
                  )
                }):<tr><td colSpan={5} style={{textAlign:'center',color:'var(--text-3)',padding:32}}>No readers paired yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {editItem&&(<div className="modal-overlay" onClick={()=>setEditItem(null)}><div className="modal" style={{maxWidth:520}} onClick={e=>e.stopPropagation()}>
        <div className="modal-header"><span className="modal-title">{editItem.icon} Edit {editItem.name}</span><button className="btn btn-ghost btn-sm" onClick={()=>setEditItem(null)}>x</button></div>
        <div style={{padding:'0 24px 24px',display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
          <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Name</div><input className="form-input" style={{width:'100%'}} value={editItem.name} onChange={e=>setEditItem((s:any)=>({...s,name:e.target.value}))} /></div>
          <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Icon</div><select className="form-select" style={{width:'100%'}} value={editItem.icon} onChange={e=>setEditItem((s:any)=>({...s,icon:e.target.value}))}>{(POS_ICON_OPTIONS.includes(editItem.icon)?POS_ICON_OPTIONS:[editItem.icon,...POS_ICON_OPTIONS]).map((ic:string)=><option key={ic} value={ic}>{ic}</option>)}</select></div>
          <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Category</div><select className="form-select" style={{width:'100%'}} value={editItem.categoryId} onChange={e=>setEditItem((s:any)=>({...s,categoryId:e.target.value}))}>{categoriesForProperty(editItem.propertyId).map(c=><option key={c.id} value={c.id}>{c.icon} {c.name}</option>)}</select></div>
          <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Sell Price</div><input className="form-input" style={{width:'100%'}} type="number" value={editItem._sell} onChange={e=>setEditItem((s:any)=>({...s,_sell:e.target.value}))} /></div>
          <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Cost Price</div><input className="form-input" style={{width:'100%'}} type="number" value={editItem._cost} onChange={e=>setEditItem((s:any)=>({...s,_cost:e.target.value}))} /></div>
          <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Tax Category</div><select className="form-select" style={{width:'100%'}} value={editItem._taxCategoryId} onChange={e=>setEditItem((s:any)=>({...s,_taxCategoryId:e.target.value}))}><option value="">— none (0%) —</option>{(posTaxCategories as any[]).map((t:any)=><option key={t.id} value={t.id}>{t.name} ({(Number(t.rate)*100).toFixed(2)}%)</option>)}</select></div>
          <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Stock Qty</div><input className="form-input" style={{width:'100%'}} type="number" value={editItem._stock} onChange={e=>setEditItem((s:any)=>({...s,_stock:e.target.value}))} /></div>
          <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Stock Min</div><input className="form-input" style={{width:'100%'}} type="number" value={editItem._min} onChange={e=>setEditItem((s:any)=>({...s,_min:e.target.value}))} /></div>
          {/* S192: property reassignment. null = company-wide. */}
          <div style={{gridColumn:'1/-1'}}>
            <div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>
              Property <span style={{color:'var(--text-3)'}}>(low-stock alerts route to this property's manager)</span>
            </div>
            <select
              className="form-select"
              style={{width:'100%'}}
              value={editItem.propertyId || ''}
              onChange={e=>setEditItem((s:any)=>({...s,propertyId:e.target.value || null}))}
            >
              <option value="" disabled>Select a property…</option>
              {(properties as any[]).map((p:any)=>(
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
          <div style={{gridColumn:'1/-1',marginTop:8}}><button className="btn btn-primary" style={{width:'100%'}} onClick={()=>updateItemMut.mutate({name:editItem.name,icon:editItem.icon,categoryId:editItem.categoryId,sellPrice:Number(editItem._sell),costPrice:Number(editItem._cost),taxCategoryId:editItem._taxCategoryId||null,stockQty:Number(editItem._stock),stockMin:Number(editItem._min),chargeEligible:editItem.chargeEligible,propertyId:editItem.propertyId || null})} disabled={updateItemMut.isLoading}>{updateItemMut.isLoading?'Saving...':'Save Changes'}</button></div>
        </div>
      </div></div>)}

      {editCategory&&(<div className="modal-overlay" onClick={()=>setEditCategory(null)}><div className="modal" style={{maxWidth:460}} onClick={e=>e.stopPropagation()}>
        <div className="modal-header"><span className="modal-title">Edit Category — {editCategory.name}</span><button className="btn btn-ghost btn-sm" onClick={()=>setEditCategory(null)}>x</button></div>
        <div style={{padding:'0 24px 24px',display:'grid',gap:12}}>
          <div style={{display:'grid',gridTemplateColumns:'80px 1fr',gap:12}}>
            <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Icon</div><select className="form-select" style={{width:'100%'}} value={editCategory._icon} onChange={e=>setEditCategory((s:any)=>({...s,_icon:e.target.value}))}>{(POS_ICON_OPTIONS.includes(editCategory._icon)?POS_ICON_OPTIONS:[editCategory._icon,...POS_ICON_OPTIONS]).map((ic:string)=><option key={ic} value={ic}>{ic}</option>)}</select></div>
            <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Name</div><input className="form-input" style={{width:'100%'}} value={editCategory._name} onChange={e=>setEditCategory((s:any)=>({...s,_name:e.target.value}))} /></div>
          </div>
          {/* Property scope — toggle per property. "All properties" (empty) = company-wide. */}
          <div>
            <div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:6}}>Available at <span style={{color:'var(--text-3)'}}>(toggle the properties that carry this category)</span></div>
            <div style={{display:'flex',flexWrap:'wrap',gap:'8px 16px'}}>
              <label style={{display:'flex',alignItems:'center',gap:6,fontSize:'.82rem',cursor:'pointer'}}>
                <input type="checkbox" checked={(editCategory._propertyIds||[]).length===0} onChange={()=>setEditCategory((s:any)=>({...s,_propertyIds:[]}))} />
                All properties
              </label>
              {(properties as any[]).map((p:any)=>(
                <label key={p.id} style={{display:'flex',alignItems:'center',gap:6,fontSize:'.82rem',cursor:'pointer'}}>
                  <input type="checkbox" checked={(editCategory._propertyIds||[]).includes(p.id)} onChange={e=>setEditCategory((s:any)=>({...s,_propertyIds: e.target.checked ? [...(s._propertyIds||[]), p.id] : (s._propertyIds||[]).filter((x:string)=>x!==p.id)}))} />
                  {p.name || p.street1}
                </label>
              ))}
            </div>
          </div>
          <button className="btn btn-primary" style={{width:'100%'}} onClick={()=>updateCategoryMut.mutate({name:editCategory._name,icon:editCategory._icon,sortOrder:Number(editCategory._sort),propertyIds: editCategory._propertyIds||[]})} disabled={updateCategoryMut.isLoading||!editCategory._name}>{updateCategoryMut.isLoading?'Saving...':'Save Changes'}</button>
        </div>
      </div></div>)}

      {showCatPropPicker&&(<div className="modal-overlay" onClick={()=>setShowCatPropPicker(false)}><div className="modal" style={{maxWidth:420}} onClick={e=>e.stopPropagation()}>
        <div className="modal-header"><span className="modal-title">Available at which properties?</span><button className="btn btn-ghost btn-sm" onClick={()=>setShowCatPropPicker(false)}>x</button></div>
        <div style={{padding:'0 24px 24px',display:'grid',gap:10}}>
          <div style={{fontSize:'.75rem',color:'var(--text-3)'}}>Choose "All properties" (company-wide) or toggle the specific properties that carry this category.</div>
          <label style={{display:'flex',alignItems:'center',gap:8,fontSize:'.88rem',cursor:'pointer',padding:'6px 0',borderBottom:'1px solid var(--border-1)'}}>
            <input type="checkbox" checked={newCategory.propertyIds.length===0} onChange={()=>setNewCategory(s=>({...s,propertyIds:[]}))} />
            All properties
          </label>
          {(properties as any[]).map((p:any)=>(
            <label key={p.id} style={{display:'flex',alignItems:'center',gap:8,fontSize:'.88rem',cursor:'pointer',padding:'4px 0'}}>
              <input type="checkbox" checked={newCategory.propertyIds.includes(p.id)} onChange={e=>setNewCategory(s=>({...s,propertyIds: e.target.checked ? [...s.propertyIds, p.id] : s.propertyIds.filter((x:string)=>x!==p.id)}))} />
              {p.name || p.street1}
            </label>
          ))}
          <button className="btn btn-primary" style={{width:'100%',marginTop:8}} onClick={()=>setShowCatPropPicker(false)}>Done</button>
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

      {readerModal&&(<div className="modal-overlay" onClick={()=>setReaderModal(false)}><div className="modal" style={{maxWidth:460}} onClick={e=>e.stopPropagation()}>
        <div className="modal-header"><span className="modal-title">Select Card Reader</span><button className="btn btn-ghost btn-sm" onClick={()=>setReaderModal(false)}>x</button></div>
        <div style={{padding:'0 24px 24px'}}>
          {terminalStatus==='error'&&<div style={{color:'var(--red)',fontSize:'.82rem',marginBottom:12}}>{terminalError}</div>}

          {/* S243: smart readers registered to the cart's property. Server-driven flow. */}
          <div style={{fontSize:'.72rem',color:'var(--text-3)',textTransform:'uppercase',letterSpacing:.5,margin:'4px 0 8px'}}>Registered readers</div>
          {!registerProperty&&<div style={{fontSize:'.78rem',color:'var(--text-3)',marginBottom:12}}>Select a property first to list its registered readers.</div>}
          {registerProperty&&(registeredReaders as RegisteredReader[]).length===0&&<div style={{fontSize:'.78rem',color:'var(--text-3)',marginBottom:12}}>No readers registered for this property. Pair one under the Readers tab, or use a Bluetooth reader below.</div>}
          {(registeredReaders as RegisteredReader[]).map(r=>(
            <div key={r.id} onClick={()=>selectSmartReader(r)} style={{border:'1px solid var(--border-1)',borderRadius:8,padding:'10px 14px',marginBottom:6,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'space-between'}} onMouseEnter={e=>(e.currentTarget.style.borderColor='var(--gold)')} onMouseLeave={e=>(e.currentTarget.style.borderColor='var(--border-1)')}>
              <div><div style={{fontWeight:600,fontSize:'.85rem'}}>{r.nickname}</div><div style={{fontSize:'.72rem',color:'var(--text-3)'}}>smart reader</div></div>
              <span style={{color:'var(--gold)',fontSize:'.78rem'}}>Use</span>
            </div>
          ))}

          {/* S243: Bluetooth handheld readers discovered via the Terminal JS SDK. Client-driven flow. */}
          <div style={{fontSize:'.72rem',color:'var(--text-3)',textTransform:'uppercase',letterSpacing:.5,margin:'14px 0 8px',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
            <span>Bluetooth readers</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={discoverAndConnect} disabled={terminalStatus==='discovering'||terminalStatus==='connecting'}>
              {terminalStatus==='discovering'?'Searching…':terminalStatus==='connecting'?'Connecting…':'Discover'}
            </button>
          </div>
          {readers.length===0&&terminalStatus==='idle'&&<div style={{fontSize:'.78rem',color:'var(--text-3)'}}>Tap Discover to scan nearby readers.</div>}
          {readers.map((r:any)=>(
            <div key={r.id} onClick={()=>selectBluetoothReader(r)} style={{border:'1px solid var(--border-1)',borderRadius:8,padding:'10px 14px',marginBottom:6,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'space-between'}} onMouseEnter={e=>(e.currentTarget.style.borderColor='var(--gold)')} onMouseLeave={e=>(e.currentTarget.style.borderColor='var(--border-1)')}>
              <div><div style={{fontWeight:600,fontSize:'.85rem'}}>{r.label||r.serialNumber}</div><div style={{fontSize:'.72rem',color:'var(--text-3)'}}>{r.deviceType} · {r.status}</div></div>
              <span style={{color:'var(--gold)',fontSize:'.78rem'}}>Connect</span>
            </div>
          ))}
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
          {!LAUNCH_HIDE_CHARGE && refundModal.tx?.paymentMethod === 'charge' ? (
            <div style={{fontSize:'.8rem',color:'var(--text-3)',padding:'8px 12px',background:'var(--bg-2)',borderRadius:4}}>Reverses on FlexCharge account (no cash payout).</div>
          ) : (
            <div>
              <div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Refund Method</div>
              <div style={{display:'flex',gap:12}}>
                <label style={{display:'flex',alignItems:'center',gap:4,cursor:'pointer'}}><input type="radio" checked={refundMethod==='cash'} onChange={()=>setRefundMethod('cash')} /> Cash</label>
                <label style={{display:'flex',alignItems:'center',gap:4,cursor:'pointer'}}><input type="radio" checked={refundMethod==='check'} onChange={()=>setRefundMethod('check')} /> Check</label>
              </div>
            </div>
          )}
          <button className="btn btn-primary" onClick={()=>refundMut.mutate()} disabled={refundMut.isLoading}>Process Refund</button>
        </div>
      </div></div>)}
    </div>
  )
}
