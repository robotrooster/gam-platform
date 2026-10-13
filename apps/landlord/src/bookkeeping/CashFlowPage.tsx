/**
 * 10/12 (Nic): the cash flow statement.
 *
 * GAM Books' own page, shown in GAM Books and inside the landlord portal's
 * Bookkeeping menu — the same bytes in apps/books and apps/landlord
 * (bookkeeping-parity.test.ts). How it reaches the API, shows a toast and
 * links to another Books page is the app's own (./adapter).
 */
import { useState } from 'react'
import { useQuery } from 'react-query'
import { formatCurrency } from '@gam/shared'
import { booksGet as get } from './adapter'
import { localToday, loadErrorText } from './booksMoney'
// 10/12 (Nic, ledger P8): once the company's books are live the cash flow is
// read from them (./LedgerStatements).
import { LedgerCashFlowView } from './LedgerStatements'

// ── CASH FLOW ────────────────────────────────────────────────────────
export function CashFlowPage(){
  const now=new Date()
  const[startDate,setStartDate]=useState(`${now.getFullYear()}-01-01`)
  const[endDate,setEndDate]=useState(localToday(now))
  const{data,isLoading,error}=useQuery(['cf',startDate,endDate],()=>get<any>(`/books/reports/cash-flow?startDate=${startDate}&endDate=${endDate}`))

  const op=(data as any)?.operating
  const fin=(data as any)?.financing
  const inv=(data as any)?.investing
  const net=(data as any)?.netCashFlow||0
  // 10/11: financing and investing totals are signed (money in is positive).
  const finNet=+(fin?.total||0), invNet=+(inv?.total||0)
  const signed=(n:number)=>n<0?`(${formatCurrency(-n)})`:formatCurrency(n)

  // 10/12 (Nic, ledger P8): the books themselves, once they are live.
  if(!error&&(data as any)?.source==='ledger')return <LedgerCashFlowView data={data} startDate={startDate} endDate={endDate} setStartDate={setStartDate} setEndDate={setEndDate}/>

  return(
    <div>
      <div className="ph">
        <div><h1 className="pt">💧 Cash Flow Statement</h1><p className="ps">Money in, by the day it arrived · {new Date(startDate+'T12:00:00').toLocaleDateString()} – {new Date(endDate+'T12:00:00').toLocaleDateString()}</p></div>
        <div style={{display:'flex',gap:8,alignItems:'center'}}>
          <input type="date" value={startDate} onChange={e=>setStartDate(e.target.value)} style={{width:'auto',padding:'5px 8px',fontSize:'.75rem'}}/>
          <span style={{color:'var(--t3)'}}>to</span>
          <input type="date" value={endDate} onChange={e=>setEndDate(e.target.value)} style={{width:'auto',padding:'5px 8px',fontSize:'.75rem'}}/>
        </div>
      </div>

      {/* 10/11: a refused report (a bookkeeper kept to some of the company's
          properties) says why — never a page of $0 that reads as real. */}
      {!!error?<div className="alert aw">{loadErrorText(error,'Could not load the cash flow.')}</div>:<>
      <div className="grid4" style={{marginBottom:16}}>
        <div className="kpi"><div className="kl">Money In</div><div className="kv g">{formatCurrency(op?.inflows?.total||0)}</div><div className="ks">By the day it arrived</div></div>
        <div className="kpi"><div className="kl">Operating Outflows</div><div className="kv r">{formatCurrency(op?.outflows?.total||0)}</div><div className="ks">Expenses, maintenance, payroll, bills</div></div>
        <div className="kpi"><div className="kl">Net Financing</div><div className={`kv ${finNet>=0?'g':'a'}`}>{signed(finNet)}</div><div className="ks">Owner money put in, less disbursements</div></div>
        <div className="kpi"><div className="kl">Net Cash Flow</div><div className={`kv ${net>=0?'g':'r'}`}>{formatCurrency(net)}</div><div className="ks">{net>=0?'Positive cash flow':'Negative cash flow'}</div></div>
      </div>

      {isLoading?<div style={{padding:32,color:'var(--t3)',textAlign:'center'}}><span className="spinner" style={{display:'inline-block'}}/></div>:(
        <div className="grid2">
          <div>
            <div className="card" style={{marginBottom:12}}>
              <div className="ct">Operating Activities</div>
              <div style={{marginBottom:10}}>
                <div style={{fontSize:'.72rem',fontWeight:700,color:'var(--t2)',marginBottom:6,textTransform:'uppercase',letterSpacing:'.06em'}}>Money in, by the day it arrived</div>
                {/* S655: every inflow line, so they add up to the total. Money
                    paid ahead is its own line on the day it arrived; a credit
                    you give never appears (no money moved). */}
                <div className="dr"><span className="dk">🏘 GAM bills paid (rent, fees, utilities)</span><span className="dv mono" style={{color:'var(--green)'}}>{formatCurrency(op?.inflows?.rentCollected||0)}</span></div>
                {!!Number(op?.inflows?.paidAhead) && <div className="dr"><span className="dk">Paid ahead for later bills</span><span className="dv mono" style={{color:'var(--green)'}}>{formatCurrency(op.inflows.paidAhead)}</span></div>}
                {!!Number(op?.inflows?.registerAndStays) && <div className="dr"><span className="dk">Register sales, stays and pay links</span><span className="dv mono" style={{color:'var(--green)'}}>{formatCurrency(op.inflows.registerAndStays)}</span></div>}
                {!!Number(op?.inflows?.moveOut) && <div className="dr"><span className="dk">Move-out settlements</span><span className="dv mono" style={{color:Number(op.inflows.moveOut)<0?'var(--red)':'var(--green)'}}>{formatCurrency(op.inflows.moveOut)}</span></div>}
                {/* 10/11: other income filed from the bank in GAM, and the Books
                    ledger's own income transactions, each on its own line. */}
                <div className="dr"><span className="dk">Other income filed in GAM</span><span className="dv mono" style={{color:'var(--green)'}}>{formatCurrency(op?.inflows?.filedOtherIncome||0)}</span></div>
                <div className="dr"><span className="dk">Income transactions in Books</span><span className="dv mono" style={{color:'var(--green)'}}>{formatCurrency(op?.inflows?.otherIncome||0)}</span></div>
                <div className="dr" style={{borderTop:'1px solid var(--b1)',paddingTop:6,marginTop:4}}><span className="dk" style={{fontWeight:700}}>Total Inflows</span><span className="dv mono" style={{color:'var(--green)',fontWeight:700}}>{formatCurrency(op?.inflows?.total||0)}</span></div>
              </div>
              <div>
                <div style={{fontSize:'.72rem',fontWeight:700,color:'var(--t2)',marginBottom:6,textTransform:'uppercase',letterSpacing:'.06em'}}>Outflows</div>
                {/* 10/11: the Expenses page's spend and maintenance costs, as the
                    owner sees them in Reports, beside Books' own expense transactions. */}
                <div className="dr"><span className="dk">Expenses paid (by the day each was paid)</span><span className="dv mono" style={{color:'var(--red)'}}>({formatCurrency(op?.outflows?.enteredExpenses||0)})</span></div>
                <div className="dr"><span className="dk">Maintenance costs</span><span className="dv mono" style={{color:'var(--red)'}}>({formatCurrency(op?.outflows?.maintenance||0)})</span></div>
                <div className="dr"><span className="dk">Expense transactions in Books</span><span className="dv mono" style={{color:'var(--red)'}}>({formatCurrency(op?.outflows?.expenses||0)})</span></div>
                <div className="dr"><span className="dk">Payroll (net)</span><span className="dv mono" style={{color:'var(--red)'}}>({formatCurrency(op?.outflows?.payroll||0)})</span></div>
                <div className="dr"><span className="dk">Bills Paid</span><span className="dv mono" style={{color:'var(--red)'}}>({formatCurrency(op?.outflows?.bills||0)})</span></div>
                {!!Number(op?.outflows?.chargebackFees) && <div className="dr"><span className="dk">Chargeback fees</span><span className="dv mono" style={{color:'var(--red)'}}>({formatCurrency(op.outflows.chargebackFees)})</span></div>}
                {!!Number(op?.outflows?.refundCardFees) && <div className="dr"><span className="dk">Card fees given back with refunds</span><span className="dv mono" style={{color:'var(--red)'}}>({formatCurrency(op.outflows.refundCardFees)})</span></div>}
                {!!Number(op?.outflows?.processingFees) && <div className="dr"><span className="dk">Payment processing fees you cover</span><span className="dv mono" style={{color:'var(--red)'}}>({formatCurrency(op.outflows.processingFees)})</span></div>}
                <div className="dr" style={{borderTop:'1px solid var(--b1)',paddingTop:6,marginTop:4}}><span className="dk" style={{fontWeight:700}}>Total Outflows</span><span className="dv mono" style={{color:'var(--red)',fontWeight:700}}>({formatCurrency(op?.outflows?.total||0)})</span></div>
              </div>
              <div className="dr" style={{borderTop:'2px solid var(--b1)',paddingTop:8,marginTop:8}}>
                <span style={{fontWeight:700,color:'var(--t0)',fontFamily:'var(--font-d)'}}>Net Operating Cash Flow</span>
                <span style={{fontFamily:'var(--font-m)',fontWeight:700,color:(op?.net||0)>=0?'var(--green)':'var(--red)',fontSize:'1rem'}}>{formatCurrency(op?.net||0)}</span>
              </div>
            </div>

            <div className="card">
              <div className="ct">Financing Activities</div>
              {/* 10/11: a bank deposit filed as the owner's own money — not income, but cash in. */}
              {!!Number(fin?.ownerContributions) && <div className="dr"><span className="dk">Owner contributions</span><span className="dv mono" style={{color:'var(--green)'}}>{formatCurrency(fin.ownerContributions)}</span></div>}
              <div className="dr"><span className="dk">Owner Disbursements</span><span className="dv mono" style={{color:'var(--amber)'}}>({formatCurrency(fin?.disbursements||0)})</span></div>
              <div className="dr" style={{borderTop:'2px solid var(--b1)',paddingTop:8,marginTop:8}}>
                <span style={{fontWeight:700,color:'var(--t0)',fontFamily:'var(--font-d)'}}>Net Financing</span>
                <span style={{fontFamily:'var(--font-m)',fontWeight:700,color:finNet>=0?'var(--green)':'var(--amber)',fontSize:'1rem'}}>{signed(finNet)}</span>
              </div>
            </div>
            {/* 10/11: a bank deposit filed as the proceeds of selling something. */}
            {!!invNet && (
              <div className="card" style={{marginTop:12}}>
                <div className="ct">Investing Activities</div>
                <div className="dr"><span className="dk">Sale proceeds</span><span className="dv mono" style={{color:'var(--green)'}}>{formatCurrency(inv?.saleProceeds||0)}</span></div>
              </div>
            )}
          </div>

          <div className="card" style={{alignSelf:'start'}}>
            <div className="ct">Cash Flow Summary</div>
            <div className="dr"><span className="dk">Net Operating</span><span className="dv mono" style={{color:(op?.net||0)>=0?'var(--green)':'var(--red)'}}>{formatCurrency(op?.net||0)}</span></div>
            <div className="dr"><span className="dk">Net Financing</span><span className="dv mono" style={{color:finNet>=0?'var(--green)':'var(--amber)'}}>{signed(finNet)}</span></div>
            {!!invNet && <div className="dr"><span className="dk">Net Investing</span><span className="dv mono" style={{color:'var(--green)'}}>{signed(invNet)}</span></div>}
            <div style={{borderTop:'2px solid var(--b1)',marginTop:12,paddingTop:12,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
              <span style={{fontFamily:'var(--font-d)',fontWeight:800,fontSize:'1rem',color:'var(--t0)'}}>NET CASH FLOW</span>
              <span style={{fontFamily:'var(--font-d)',fontWeight:800,fontSize:'1.4rem',color:net>=0?'var(--green)':'var(--red)'}}>{formatCurrency(net)}</span>
            </div>
            {/* Beside the totals, never in them. */}
            {(!!Number((data as any)?.stillClearing)||!!Number((data as any)?.depositsHeld)||!!Number((data as any)?.nonCash?.keptAtMoveOut))&&(
              <div style={{marginTop:14,paddingTop:10,borderTop:'1px dashed var(--b1)'}}>
                {!!Number((data as any)?.stillClearing)&&<div className="dr"><span className="dk">Still clearing (not arrived yet)</span><span className="dv mono">{formatCurrency((data as any).stillClearing)}</span></div>}
                {!!Number((data as any)?.depositsHeld)&&<div className="dr"><span className="dk">Deposits received (held for tenants)</span><span className="dv mono">{formatCurrency((data as any).depositsHeld)}</span></div>}
                {!!Number((data as any)?.nonCash?.keptAtMoveOut)&&<div className="dr"><span className="dk">Kept from deposits you already held</span><span className="dv mono">{formatCurrency((data as any).nonCash.keptAtMoveOut)}</span></div>}
              </div>
            )}
            <div className="bnote">{(data as any)?.meta?.note||'Money in, by the day it arrived.'}</div>
          </div>
        </div>
      )}
      </>}
    </div>
  )
}
