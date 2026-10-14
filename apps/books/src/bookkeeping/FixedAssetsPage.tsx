/**
 * 10/12 (Nic): "fixed assets with depreciation". Buildings, improvements to a
 * property, equipment and vehicles wear out over years: their cost is spread
 * over the life the landlord chooses (straight line), one amount at the end of
 * each month. Land never wears out. An expense filed under a
 * capital-improvement category (one that charges to an asset account) can be
 * turned into an asset here. 10/13 (Nic): an asset typed in by hand ASKS where
 * the money came from (cash on hand / the owner put money in / a loan /
 * already an expense) and posts to that; "already an expense" links that
 * expense and its cost moves to the asset. 10/13 (Nic): "Funding: ALLOW A MIX
 * (several funding lines adding up to the cost; a loan may spread over several
 * assets)" — one line per place the money came from, chosen on each asset as
 * it happens ("they don't pick as a setting, they pick as the expense
 * happens"). And "each expense is chosen on the split or specific unit or
 * property at the time of logging": each asset says where it and its
 * depreciation go (CostPlaceField); nothing saves until it is answered.
 *
 * GAM Books' own page, shown in GAM Books and inside the landlord portal's
 * Bookkeeping menu — the same bytes in apps/books and apps/landlord
 * (bookkeeping-parity.test.ts). How it reaches the API, shows a toast and
 * links to another Books page is the app's own (./adapter).
 */
import React, { useState } from 'react'
import { useQuery, useQueryClient } from 'react-query'
import {
  formatCurrency, BOOKS_FIXED_ASSET_CLASSES, BOOKS_FIXED_ASSET_CLASS_LABEL, BOOKS_DEPRECIATION_METHOD_LABEL,
  BOOKS_FIXED_ASSET_FUNDED_BY, BOOKS_FIXED_ASSET_FUNDED_BY_LABEL, BOOKS_FIXED_ASSET_CLASS_ROLE, BOOKS_LOAN_FUNDED_TO_ASSET_ROLE,
  BOOKS_COST_PLACE_NONE_LABEL, BOOKS_COST_PLACE_LABEL, type BooksFixedAssetFundedBy,
} from '@gam/shared'
import { booksGet as get, booksPost as post, booksPatch as patch, toast } from './adapter'
import { Modal } from './common'
import { VoidReasonModal } from './VoidReasonModal'
import {
  CostPlaceField, useCostPlaces, costPlaceOf, costPlaceChosen, costPlaceBody, BLANK_COST_PLACE,
  type CostPlaceValue, type CostPlaceProperty,
} from './CostPlaceField'

const day=(d:string|null|undefined)=>d?new Date(`${d.slice(0,10)}T12:00:00`).toLocaleDateString():'—'
const classLabel=(c:string)=>(BOOKS_FIXED_ASSET_CLASS_LABEL as Record<string,string>)[c]??'—'
const years=(y:string|number|null|undefined)=>y==null||y===''?'—':`${+y} yr`
const fundedLabel=(f:string|null|undefined)=>f?(BOOKS_FIXED_ASSET_FUNDED_BY_LABEL as Record<string,string>)[f]??'—':''
// 10/13 (Nic): what each answer to "where did the money come from" puts on the books.
const FUNDED_HELP:Record<string,string>={
  cash:'Paid with cash you had on hand: this part comes out of your office cash (Undeposited funds).',
  owner:'Paid with your own money: this part counts as money you put into the company.',
  loan:'A loan on your Loans page paid the seller: that loan already put this part on your books.',
  expense:'You already entered it as an expense: that expense moves to this asset, whole, so it counts once.',
}

const blankAsset={name:'',assetClass:'building',cost:'',salvageValue:'0',acquiredOn:'',inServiceDate:'',lifeYears:'',priorDepreciation:'',notes:''}
type AssetForm=typeof blankAsset
// 10/13 (Nic, "ALLOW A MIX"): one line of where the money came from.
interface FundingFormLine{kind:BooksFixedAssetFundedBy|'';amount:string;loanId:string;expenseId:string}
const blankLine=():FundingFormLine=>({kind:'',amount:'',loanId:'',expenseId:''})
/** A saved asset's lines for its edit form (one said once becomes one line for the whole cost). */
const fundingLinesOf=(a:any):FundingFormLine[]=>a?.funding?.length
  ?a.funding.map((f:any)=>({kind:f.kind,amount:String(+f.amount),loanId:f.loanId??'',expenseId:f.expenseId??''}))
  :a?.fundedBy&&a.fundedBy!=='expense'?[{kind:a.fundedBy,amount:String(+a.cost),loanId:a.fundedLoanId??'',expenseId:''}]:[blankLine()]
/** Where the money came from, in words, for an asset's row. */
const fundingWords=(a:any)=>a.funding?.length
  ?(a.funding as any[]).map(f=>`${fundedLabel(f.kind)}${f.loanName?`: ${f.loanName}`:f.expenseDescription?`: ${f.expenseDescription}`:''} ${formatCurrency(f.amount)}`).join(' + ')
  :a.fundedBy?`${fundedLabel(a.fundedBy)}${a.fundedLoanName?`: ${a.fundedLoanName}`:''}`:''
/** 10/13 (Nic): where an asset and its depreciation go, in words. */
const placeWords=(a:any)=>a.costPlace==='split_by_units'?BOOKS_COST_PLACE_LABEL.split_by_units  // wire-ok: a shared label key, not a field off an API response
  :a.unitNumber?`${a.propertyName??''} · Unit ${a.unitNumber}`:(a.propertyName??BOOKS_COST_PLACE_NONE_LABEL)

export function FixedAssetsPage(){
  const qc=useQueryClient()
  const[showVoided,setShowVoided]=useState(false)
  const{data:assets=[],isLoading}=useQuery(['assets',showVoided],()=>get<any[]>(`/books/fixed-assets${showVoided?'?includeVoided=true':''}`))
  const{data:capital=[]}=useQuery('capitalExpenses',()=>get<any[]>('/books/fixed-assets/capital-expenses'))
  const{data:opts}=useQuery('loanOpts',()=>get<any>('/books/loans/form-options'))
  const{properties,asked}=useCostPlaces()
  const[editing,setEditing]=useState<any|null|'new'>(null)
  const[fromExpense,setFromExpense]=useState<any|null>(null)
  const[voiding,setVoiding]=useState<any|null>(null)
  const refresh=()=>{qc.invalidateQueries('assets');qc.invalidateQueries('capitalExpenses')}

  const live=(assets as any[]).filter(a=>!a.voidedAt)
  const cost=live.reduce((s,a)=>s+(+a.cost||0),0)
  const taken=live.reduce((s,a)=>s+(+a.depreciatedToDate||0),0)
  const monthly=live.reduce((s,a)=>s+(a.monthsLeft>0?+a.monthly||0:0),0)

  return(
    <div>
      <div className="ph">
        <div><h1 className="pt">🏗 Fixed Assets</h1><p className="ps">Buildings, improvements, equipment and vehicles wear out over years. Their cost is spread over the life you choose, the same amount each month. Your accountant can tell you which life to use.</p></div>
        <button className="btn bp" onClick={()=>setEditing('new')}>+ Add Asset</button>
      </div>

      <div className="grid4" style={{marginBottom:16}}>
        <div className="kpi"><div className="kl">What They Cost</div><div className="kv">{formatCurrency(cost)}</div><div className="ks">{live.length} assets</div></div>
        <div className="kpi"><div className="kl">Depreciation So Far</div><div className="kv a">{formatCurrency(taken)}</div><div className="ks">Through the last month that ended</div></div>
        <div className="kpi"><div className="kl">Worth on the Books</div><div className="kv gold">{formatCurrency(cost-taken)}</div><div className="ks">Cost less depreciation</div></div>
        <div className="kpi"><div className="kl">Each Month</div><div className="kv t">{formatCurrency(monthly)}</div><div className="ks">Posted at the end of the month</div></div>
      </div>

      {(capital as any[]).length>0&&(
        <div className="card" style={{marginBottom:16}}>
          <div className="ct">Capital improvements not yet an asset</div>
          <p style={{fontSize:'.75rem',color:'var(--t3)',marginTop:0}}>These expenses are filed under a category that charges to an asset account. Make each one an asset to spread its cost over its life.</p>
          <div style={{overflowX:'auto'}}>
            <table className="tbl" style={{minWidth:480}}>
              <thead><tr><th>Expense</th><th>Category</th><th>Property</th><th>Day</th><th>Cost</th><th></th></tr></thead>
              <tbody>
                {(capital as any[]).map((e:any)=>(
                  <tr key={e.id}>
                    <td style={{fontWeight:600,color:'var(--t0)'}}>{e.description||'Capital improvement'}</td>
                    <td style={{fontSize:'.72rem'}}>{e.categoryName}</td>
                    <td style={{fontSize:'.72rem'}}>{e.propertyName??BOOKS_COST_PLACE_NONE_LABEL}</td>
                    <td style={{fontSize:'.72rem'}}>{day(e.expenseDate)}</td>
                    <td className="mono">{formatCurrency(e.amount)}</td>
                    <td><button className="btn bp bsm" onClick={()=>setFromExpense(e)}>Make it an asset</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div style={{display:'flex',justifyContent:'flex-end',marginBottom:8}}>
        <label style={{display:'flex',alignItems:'center',gap:6,fontSize:'.75rem',textTransform:'none',letterSpacing:0,color:'var(--t2)',marginBottom:0}}>
          <input type="checkbox" checked={showVoided} onChange={e=>setShowVoided(e.target.checked)} style={{width:'auto'}}/> Show voided
        </label>
      </div>

      <div className="card" style={{padding:0}}>
        {isLoading?<div style={{padding:32,color:'var(--t3)',textAlign:'center'}}><span className="spinner" style={{display:'inline-block'}}/></div>:(
          <div style={{overflowX:'auto'}}>
            <table className="tbl" style={{minWidth:720}}>
              <thead><tr><th>Asset</th><th>Goes to</th><th>In service</th><th>Cost</th><th>Life</th><th>Monthly</th><th>So far</th><th>On the books</th><th></th></tr></thead>
              <tbody>
                {(assets as any[]).length?(assets as any[]).map((a:any)=>(
                  <tr key={a.id} style={{opacity:a.voidedAt?.5:1}}>
                    <td>
                      <div style={{fontWeight:600,color:'var(--t0)'}}>{a.name}</div>
                      <div style={{fontSize:'.66rem',color:'var(--t3)'}}>{classLabel(a.assetClass)}{a.sourceExpenseId?' · from an expense':''}{!a.sourceExpenseId&&fundingWords(a)?` · ${fundingWords(a)}`:''}{a.opensAtBooksStart?' · owned before your books start':''}{a.voidedAt?' · voided':''}</div>
                      {a.problem&&<div className="badge ba" style={{marginTop:4}}>{a.problem}</div>}
                      {!a.voidedAt&&!a.opensAtBooksStart&&!a.sourceExpenseId&&!a.fundedBy&&!a.funding?.length&&a.booksStart&&<div className="badge ba" style={{marginTop:4}}>Say where the money came from (Edit) so its cost is on your books</div>}
                      {!a.voidedAt&&!a.costPlace&&!a.propertyId&&<div className="badge ba" style={{marginTop:4}}>Say where it goes (Edit)</div>}
                    </td>
                    <td style={{fontSize:'.72rem'}}>{placeWords(a)}</td>
                    <td style={{fontSize:'.72rem'}}>{day(a.inServiceDate)}</td>
                    <td className="mono">{formatCurrency(a.cost)}</td>
                    <td style={{fontSize:'.72rem'}}>{a.depreciates?years(a.lifeYears):'Does not wear out'}</td>
                    <td className="mono">{a.depreciates&&a.monthsLeft>0?formatCurrency(a.monthly):'—'}</td>
                    <td className="mono" style={{color:'var(--amber)'}}>{formatCurrency(a.depreciatedToDate)}</td>
                    <td className="mono" style={{color:'var(--gold)',fontWeight:600}}>{formatCurrency(a.bookValue)}</td>
                    <td style={{whiteSpace:'nowrap'}}>{!a.voidedAt&&<>
                      <button className="btn bp bsm" onClick={()=>setEditing(a)}>Edit</button>{' '}
                      <button className="btn bp bsm" onClick={()=>setVoiding(a)}>Void</button>
                    </>}</td>
                  </tr>
                )):<tr><td colSpan={9}><div className="empty">No fixed assets yet. Add a building, an improvement, equipment or a vehicle.</div></td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editing&&<AssetFormModal asset={editing==='new'?null:editing} booksStart={opts?.booksStartDate??null} properties={properties} asked={asked}
        onClose={()=>setEditing(null)} onSaved={()=>{refresh();setEditing(null)}}/>}
      {fromExpense&&<FromExpenseModal expense={fromExpense} properties={properties} onClose={()=>setFromExpense(null)} onSaved={()=>{refresh();setFromExpense(null)}}/>}
      {voiding&&<VoidReasonModal title={`Void ${voiding.name}`} what="Void this asset if it was entered by mistake; its opening and every month of depreciation are taken back."
        onClose={()=>setVoiding(null)} onVoid={async r=>{await post(`/books/fixed-assets/${voiding.id}/void`,{reason:r});toast('Asset voided.');refresh()}}/>}
    </div>
  )
}

function AssetFormModal({asset,booksStart,properties,asked,onClose,onSaved}:{asset:any|null;booksStart:string|null;properties:CostPlaceProperty[];asked:boolean;onClose:()=>void;onSaved:()=>void}){
  const[form,setForm]=useState<AssetForm>(()=>asset?{
    name:asset.name??'',assetClass:asset.assetClass,cost:String(+asset.cost),salvageValue:String(+asset.salvageValue||0),
    acquiredOn:asset.acquiredOn??'',inServiceDate:asset.inServiceDate??'',lifeYears:asset.lifeYears!=null?String(+asset.lifeYears):'',
    priorDepreciation:asset.priorDepreciation!=null?String(+asset.priorDepreciation):'',notes:asset.notes??''}:blankAsset)
  // 10/13 (Nic): where it sits and its depreciation goes — asked, never chosen for the person.
  const[place,setPlace]=useState<CostPlaceValue>(()=>costPlaceOf(asset))
  // 10/13 (Nic, "ALLOW A MIX"): where each part of the money came from.
  const[lines,setLines]=useState<FundingFormLine[]>(()=>fundingLinesOf(asset))
  const[err,setErr]=useState('')
  const[saving,setSaving]=useState(false)
  const set=(k:keyof AssetForm)=>(e:React.ChangeEvent<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>)=>setForm(p=>({...p,[k]:e.target.value}))
  const fromExpense=!!asset?.sourceExpenseId
  const land=form.assetClass==='land'
  const owned=!!booksStart&&!!form.acquiredOn&&form.acquiredOn<booksStart&&!fromExpense
  // 10/13 (Nic): "the form ASKS where the money came from" — for anything not owned before the books start.
  const asks=asked&&!fromExpense&&!owned
  const{data:loans=[]}=useQuery('assetLoans',()=>get<any[]>('/books/loans'),{enabled:asks})
  const{data:linkable=[]}=useQuery('assetExpenses',()=>get<any[]>('/books/fixed-assets/linkable-expenses'),{enabled:asks})
  // A loan that paid the seller of what this asset is (its posting put the cost on this asset's account).
  const role=(BOOKS_FIXED_ASSET_CLASS_ROLE as Record<string,string>)[form.assetClass]
  const loanFits=(l:any)=>!l.voidedAt&&!!l.fundedTo&&(BOOKS_LOAN_FUNDED_TO_ASSET_ROLE as Record<string,string|null>)[l.fundedTo]===role
  // The expenses a line can name: those no asset holds yet, and the ones this asset's own lines name.
  // 10/13 review: filed where this asset goes (its property, or none for a
  // split) — an expense pays for part of an asset only where the asset is.
  const placeProperty=place.costPlace==='split_by_units'?null:place.propertyId||null
  const atPlace=(x:any)=>!costPlaceChosen(place)||(x.propertyId??null)===placeProperty
  const expenses=[...(asset?.funding??[]).filter((f:any)=>f.expenseId).map((f:any)=>({id:f.expenseId,amount:+f.amount,description:f.expenseDescription,expenseDate:f.expenseDate,propertyId:asset.propertyId??null})),
    ...(linkable as any[])].filter(atPlace)
  const total=Math.round(lines.reduce((t,l)=>t+(+l.amount||0),0)*100)/100
  const setLine=(i:number,patchLine:Partial<FundingFormLine>)=>setLines(ls=>ls.map((l,j)=>j===i?{...l,...patchLine}:l))
  const pickExpense=(i:number,id:string)=>{
    const x=expenses.find(r=>r.id===id)
    setLine(i,{expenseId:id,amount:x?String(+x.amount):''})
    if(x)setForm(p=>({...p,name:p.name||x.description||'',acquiredOn:p.acquiredOn||x.expenseDate||''}))
  }
  const linesReady=!asks||(lines.length>0&&lines.every(l=>l.kind&&+l.amount>0&&(l.kind!=='loan'||l.loanId)&&(l.kind!=='expense'||l.expenseId))
    &&Math.round(total*100)===Math.round((+form.cost||0)*100))
  const save=async(e:React.FormEvent)=>{
    e.preventDefault();setSaving(true);setErr('')
    const body:any={...form,lifeYears:land?'':form.lifeYears,priorDepreciation:owned&&!land?form.priorDepreciation:''}
    if(fromExpense){delete body.cost;delete body.acquiredOn;body.costPlace=place.costPlace||null;body.unitId=place.costPlace==='unit'?place.unitId||null:null}
    else if(asked)Object.assign(body,costPlaceBody(place))
    if(asks)body.funding=lines.map(l=>({kind:l.kind,amount:+l.amount,loanId:l.kind==='loan'?l.loanId:null,expenseId:l.kind==='expense'?l.expenseId:null}))
    try{
      if(asset)await patch(`/books/fixed-assets/${asset.id}`,body)
      else await post('/books/fixed-assets',body)
      toast(asset?'Asset saved.':`${form.name} added.`)
      onSaved()
    }catch(ex:any){setErr(ex.response?.data?.error||'Could not save the asset.')}
    finally{setSaving(false)}
  }
  return(
    <Modal title={asset?`Edit ${asset.name}`:'Add Asset'} onClose={onClose}>
      {err&&<div className="alert ae">{err}</div>}
      <form onSubmit={save}>
        <div className="frow2">
          <div><label>Name</label><input type="text" value={form.name} onChange={set('name')} maxLength={120} required placeholder="e.g. Clubhouse, Riding mower"/></div>
          <div><label>What it is</label>
            <select value={form.assetClass} onChange={set('assetClass')}>
              {BOOKS_FIXED_ASSET_CLASSES.map(c=><option key={c} value={c}>{classLabel(c)}</option>)}
            </select>
          </div>
        </div>
        {asked&&<CostPlaceField value={place} onChange={setPlace} properties={properties} what="this asset (and its depreciation)" name="assetPlace"
          fixedPropertyId={fromExpense?(asset.propertyId??null):undefined}
          allowed={fromExpense?(asset.propertyId?['property','unit']:['split_by_units']):undefined}/>}
        <div className="frow2">
          <div><label>What it cost</label><input type="number" min="0.01" step="0.01" value={form.cost} onChange={set('cost')} required disabled={fromExpense}/></div>
          <div><label>Worth at the end of its life</label><input type="number" min="0" step="0.01" value={form.salvageValue} onChange={set('salvageValue')}/></div>
        </div>
        <div className="frow2">
          <div><label>Day you bought it</label><input type="date" value={form.acquiredOn} onChange={set('acquiredOn')} required disabled={fromExpense}/></div>
          <div><label>Day it went into service</label><input type="date" value={form.inServiceDate} onChange={set('inServiceDate')} placeholder="Same as bought"/></div>
        </div>
        {asks&&<div className="frow"><label>Where the money came from</label>
          <p style={{fontSize:'.72rem',color:'var(--t3)',marginTop:0}}>One line for each place the money came from; together they add up to what it cost. A loan may pay for part of it, and the rest of the loan for other assets.</p>
          {lines.map((l,i)=>(
            <div key={i} className="card" style={{background:'var(--bg3)',marginBottom:8,padding:10}}>
              <div className="frow2" style={{marginBottom:6}}>
                <div><label>From</label>
                  <select value={l.kind} onChange={e=>setLine(i,{kind:e.target.value as BooksFixedAssetFundedBy,loanId:'',expenseId:'',amount:e.target.value==='expense'?'':l.amount})} required>
                    <option value="">Choose where it came from</option>
                    {BOOKS_FIXED_ASSET_FUNDED_BY.map(f=><option key={f} value={f}>{fundedLabel(f)}</option>)}
                  </select>
                </div>
                <div><label>Amount</label><input type="number" min="0.01" step="0.01" value={l.amount} onChange={e=>setLine(i,{amount:e.target.value})} required disabled={l.kind==='expense'}/></div>
              </div>
              {l.kind&&<p style={{fontSize:'.7rem',color:'var(--t3)',margin:'0 0 6px'}}>{FUNDED_HELP[l.kind]}</p>}
              {l.kind==='loan'&&<div className="frow" style={{marginBottom:6}}><label>The loan</label>
                <select value={l.loanId} onChange={e=>setLine(i,{loanId:e.target.value})} required>
                  <option value="">Choose the loan that paid the seller</option>
                  {(loans as any[]).filter(loanFits).map(x=><option key={x.id} value={x.id}>{x.name}{x.lenderName?` (${x.lenderName})`:''} · {formatCurrency(Math.max(0,+x.originalAmount-(+x.usedByAssets||0)))} not yet on an asset</option>)}
                </select>
                {!(loans as any[]).some(loanFits)&&<p style={{fontSize:'.72rem',color:'var(--t3)',marginBottom:0}}>No loan on your Loans page paid the seller of {role==='equipment'?'equipment or a vehicle':'a property'}. Add it there first (where the money went: straight to the seller). A loan whose money went into your bank paid nothing itself: file the bank payment as an expense and choose "Already an expense".</p>}
              </div>}
              {l.kind==='expense'&&<div className="frow" style={{marginBottom:6}}><label>The expense it was</label>
                <select value={l.expenseId} onChange={e=>pickExpense(i,e.target.value)} required>
                  <option value="">Choose the expense</option>
                  {expenses.map(x=><option key={x.id} value={x.id}>{x.description||x.categoryName||'Expense'} · {formatCurrency(x.amount)} · {day(x.expenseDate)}</option>)}
                </select>
                {expenses.length===0&&<p style={{fontSize:'.72rem',color:'var(--t3)',marginBottom:0}}>{costPlaceChosen(place)?'No expense is filed where this asset goes. An expense pays for part of an asset only where the asset is.':'Say where this asset goes first.'}</p>}
              </div>}
              {lines.length>1&&<button type="button" className="btn bg-btn bsm" onClick={()=>setLines(ls=>ls.filter((_,j)=>j!==i))}>Remove this line</button>}
            </div>
          ))}
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:8,flexWrap:'wrap'}}>
            <button type="button" className="btn bp bsm" onClick={()=>setLines(ls=>[...ls,blankLine()])}>+ Another place the money came from</button>
            <span className="mono" style={{fontSize:'.75rem',color:Math.round(total*100)===Math.round((+form.cost||0)*100)?'var(--t2)':'var(--amber)'}}>
              Adds up to {formatCurrency(total)} of {formatCurrency(+form.cost||0)}
            </span>
          </div>
        </div>}
        {!land&&<div className="frow2">
          <div><label>Life in years</label><input type="number" min="0.0833" max="100" step="0.0001" value={form.lifeYears} onChange={set('lifeYears')} required placeholder="e.g. 27.5"/></div>
          <div><label>Method</label><input type="text" value={BOOKS_DEPRECIATION_METHOD_LABEL['straight_line']} disabled/></div>
        </div>}
        {owned&&!land&&<div className="card" style={{background:'var(--bg3)',marginBottom:14}}>
          <p style={{fontSize:'.76rem',color:'var(--t2)',marginTop:0}}>You owned this before your books start ({day(booksStart)}), so it opens on your books at its cost less the depreciation already taken. Leave this blank to use the straight-line months before that day, or enter the figure from your earlier records.</p>
          <div className="frow" style={{marginBottom:0}}><label>Depreciation already taken (optional)</label><input type="number" min="0" step="0.01" value={form.priorDepreciation} onChange={set('priorDepreciation')}/></div>
        </div>}
        <div className="frow"><label>Notes (optional)</label><textarea rows={2} value={form.notes} onChange={set('notes')}/></div>
        <div className="factions">
          <button type="button" className="btn bg-btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn bp" disabled={saving||(asked&&!costPlaceChosen({...place,propertyId:fromExpense?(asset.propertyId??''):place.propertyId}))||!linesReady}>{saving?<><span className="spinner"/>Saving…</>:asset?'Save':'Add Asset'}</button>
        </div>
      </form>
    </Modal>
  )
}

function FromExpenseModal({expense,properties,onClose,onSaved}:{expense:any;properties:CostPlaceProperty[];onClose:()=>void;onSaved:()=>void}){
  const[form,setForm]=useState({name:expense.description||'',assetClass:'improvement',salvageValue:'0',inServiceDate:expense.expenseDate??'',lifeYears:'',notes:''})
  // 10/13 (Nic): where its depreciation goes — it sits where the expense was filed.
  const[place,setPlace]=useState<CostPlaceValue>(BLANK_COST_PLACE)
  const[err,setErr]=useState('')
  const[saving,setSaving]=useState(false)
  const set=(k:keyof typeof form)=>(e:React.ChangeEvent<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>)=>setForm(p=>({...p,[k]:e.target.value}))
  const land=form.assetClass==='land'
  const save=async(e:React.FormEvent)=>{
    e.preventDefault();setSaving(true);setErr('')
    try{
      await post(`/books/fixed-assets/from-expense/${expense.id}`,{...form,lifeYears:land?'':form.lifeYears,
        costPlace:place.costPlace||null,unitId:place.costPlace==='unit'?place.unitId||null:null})
      toast('It is a fixed asset now.')
      onSaved()
    }catch(ex:any){setErr(ex.response?.data?.error||'Could not make it an asset.')}
    finally{setSaving(false)}
  }
  return(
    <Modal title="Make it an asset" onClose={onClose}>
      {err&&<div className="alert ae">{err}</div>}
      <form onSubmit={save}>
        <p style={{fontSize:'.78rem',color:'var(--t2)',marginTop:0}}>{formatCurrency(expense.amount)} on {day(expense.expenseDate)}, filed under {expense.categoryName}. Its cost is already on your books as an asset; this spreads it over its life.</p>
        <div className="frow2">
          <div><label>Name</label><input type="text" value={form.name} onChange={set('name')} maxLength={120}/></div>
          <div><label>What it is</label>
            <select value={form.assetClass} onChange={set('assetClass')}>
              {BOOKS_FIXED_ASSET_CLASSES.map(c=><option key={c} value={c}>{classLabel(c)}</option>)}
            </select>
          </div>
        </div>
        <CostPlaceField value={place} onChange={setPlace} properties={properties} what="its depreciation" name="fromExpensePlace"
          fixedPropertyId={expense.propertyId??null} allowed={expense.propertyId?['property','unit']:['split_by_units']}/>
        <div className="frow2">
          <div><label>Day it went into service</label><input type="date" value={form.inServiceDate} onChange={set('inServiceDate')}/></div>
          <div><label>Worth at the end of its life</label><input type="number" min="0" step="0.01" value={form.salvageValue} onChange={set('salvageValue')}/></div>
        </div>
        {!land&&<div className="frow"><label>Life in years</label><input type="number" min="0.0833" max="100" step="0.0001" value={form.lifeYears} onChange={set('lifeYears')} required placeholder="e.g. 15"/></div>}
        <div className="factions">
          <button type="button" className="btn bg-btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn bp" disabled={saving||!costPlaceChosen({...place,propertyId:expense.propertyId??''})}>{saving?<><span className="spinner"/>Saving…</>:'Make it an asset'}</button>
        </div>
      </form>
    </Modal>
  )
}
