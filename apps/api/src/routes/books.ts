import { Router } from 'express'
import { db, queryOne } from '../db'
import { requireAuth, requireLandlord } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'

export const booksRouter = Router()
booksRouter.use(requireAuth)

// ── Scope helper — admin sees all, landlord sees own, bookkeeper uses active client ──
function landlordScope(user: any) {
  if (user.role === 'admin' || user.role === 'super_admin') return null
  if (user.role === 'bookkeeper') return user.activeClientId || null // set via X-Client-Id header
  return user.landlordId || user.profileId
}

// Middleware to inject activeClientId for bookkeepers from X-Client-Id header
import { Request, Response, NextFunction } from 'express'
booksRouter.use((req: Request, _res: Response, next: NextFunction) => {
  if (req.user?.role === 'bookkeeper') {
    (req.user as any).activeClientId = req.headers['x-client-id'] || null
  }
  next()
})

// ════════════════════════════════════════
// CHART OF ACCOUNTS
// ════════════════════════════════════════

// GET /api/books/accounts
booksRouter.get('/accounts', async (req, res, next) => {
  try {
    const lid = landlordScope(req.user)
    const { rows } = await db.query(
      `SELECT * FROM books_accounts
       WHERE (landlord_id = $1 OR $1 IS NULL)
       AND active = TRUE
       ORDER BY code ASC`,
      [lid]
    )
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// POST /api/books/accounts
booksRouter.post('/accounts', async (req, res, next) => {
  try {
    const lid = landlordScope(req.user)
    const { code, name, type, subtype, description } = req.body
    if (!code || !name || !type) throw new AppError(400, 'code, name, and type are required')
    const exists = await queryOne(
      'SELECT id FROM books_accounts WHERE code=$1 AND (landlord_id=$2 OR landlord_id IS NULL)',
      [code, lid]
    )
    if (exists) throw new AppError(409, `Account code ${code} already exists`)
    const { rows: [acct] } = await db.query(
      `INSERT INTO books_accounts (landlord_id, code, name, type, subtype, description)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [lid, code, name, type, subtype || null, description || null]
    )
    res.status(201).json({ success: true, data: acct })
  } catch (e) { next(e) }
})

// PATCH /api/books/accounts/:id
booksRouter.patch('/accounts/:id', async (req, res, next) => {
  try {
    const lid = landlordScope(req.user)
    const { name, subtype, description, active } = req.body
    const { rows: [acct] } = await db.query(
      `UPDATE books_accounts SET
         name=COALESCE($1,name), subtype=COALESCE($2,subtype),
         description=COALESCE($3,description), active=COALESCE($4,active),
         updated_at=NOW()
       WHERE id=$5 AND (landlord_id=$6 OR $6 IS NULL) RETURNING *`,
      [name||null, subtype||null, description||null, active??null, req.params.id, lid]
    )
    if (!acct) throw new AppError(404, 'Account not found')
    res.json({ success: true, data: acct })
  } catch (e) { next(e) }
})

// DELETE /api/books/accounts/:id
booksRouter.delete('/accounts/:id', async (req, res, next) => {
  try {
    const lid = landlordScope(req.user)
    await db.query(
      `UPDATE books_accounts SET active=FALSE, updated_at=NOW()
       WHERE id=$1 AND (landlord_id=$2 OR $2 IS NULL)`,
      [req.params.id, lid]
    )
    res.json({ success: true })
  } catch (e) { next(e) }
})

// POST /api/books/accounts/seed — seed standard property mgmt COA
booksRouter.post('/accounts/seed', async (req, res, next) => {
  try {
    const lid = landlordScope(req.user)
    const standardAccounts = [
      // Assets
      { code:'1010', name:'Checking Account',           type:'asset',     subtype:'bank' },
      { code:'1020', name:'Savings / Reserve Account',  type:'asset',     subtype:'bank' },
      { code:'1030', name:'Security Deposits Held',     type:'asset',     subtype:'current' },
      { code:'1100', name:'Accounts Receivable',        type:'asset',     subtype:'current' },
      { code:'1200', name:'Prepaid Expenses',           type:'asset',     subtype:'current' },
      { code:'1500', name:'Rental Property',            type:'asset',     subtype:'fixed' },
      { code:'1510', name:'Accumulated Depreciation',   type:'asset',     subtype:'fixed' },
      // Liabilities
      { code:'2010', name:'Accounts Payable',           type:'liability', subtype:'current' },
      { code:'2020', name:'Security Deposits Payable',  type:'liability', subtype:'current' },
      { code:'2030', name:'Payroll Liabilities',        type:'liability', subtype:'current' },
      { code:'2040', name:'Sales Tax Payable',          type:'liability', subtype:'current' },
      { code:'2100', name:'Mortgage Payable',           type:'liability', subtype:'longterm' },
      // Equity
      { code:'3010', name:'Owner Equity',               type:'equity',    subtype:null },
      { code:'3020', name:'Owner Draws',                type:'equity',    subtype:null },
      { code:'3030', name:'Retained Earnings',          type:'equity',    subtype:null },
      // Income
      { code:'4010', name:'Rental Income',              type:'income',    subtype:'operating' },
      { code:'4020', name:'Late Fee Income',            type:'income',    subtype:'operating' },
      { code:'4030', name:'Application Fee Income',     type:'income',    subtype:'operating' },
      { code:'4040', name:'Pet Fee Income',             type:'income',    subtype:'operating' },
      { code:'4050', name:'Laundry / Vending Income',   type:'income',    subtype:'operating' },
      { code:'4060', name:'Storage Fee Income',         type:'income',    subtype:'operating' },
      { code:'4070', name:'Utility Reimbursements',     type:'income',    subtype:'operating' },
      { code:'4900', name:'Other Income',               type:'income',    subtype:'other' },
      // Expenses
      { code:'5010', name:'Mortgage / Loan Interest',   type:'expense',   subtype:'operating' },
      { code:'5020', name:'Property Taxes',             type:'expense',   subtype:'operating' },
      { code:'5030', name:'Property Insurance',         type:'expense',   subtype:'operating' },
      { code:'5040', name:'Repairs & Maintenance',      type:'expense',   subtype:'operating' },
      { code:'5050', name:'Utilities',                  type:'expense',   subtype:'operating' },
      { code:'5060', name:'Landscaping',                type:'expense',   subtype:'operating' },
      { code:'5070', name:'Pest Control',               type:'expense',   subtype:'operating' },
      { code:'5080', name:'Property Management Fees',   type:'expense',   subtype:'operating' },
      { code:'5090', name:'Advertising & Marketing',    type:'expense',   subtype:'operating' },
      { code:'5100', name:'Legal & Professional Fees',  type:'expense',   subtype:'operating' },
      { code:'5110', name:'Accounting & Bookkeeping',   type:'expense',   subtype:'operating' },
      { code:'5120', name:'Payroll Expenses',           type:'expense',   subtype:'operating' },
      { code:'5130', name:'Contractor Payments',        type:'expense',   subtype:'operating' },
      { code:'5140', name:'Office Supplies',            type:'expense',   subtype:'operating' },
      { code:'5150', name:'Software & Subscriptions',   type:'expense',   subtype:'operating' },
      { code:'5160', name:'Vehicle & Travel',           type:'expense',   subtype:'operating' },
      { code:'5170', name:'Depreciation Expense',       type:'expense',   subtype:'operating' },
      { code:'5900', name:'Other Expenses',             type:'expense',   subtype:'other' },
    ]
    let inserted = 0
    for (const a of standardAccounts) {
      const exists = await queryOne(
        'SELECT id FROM books_accounts WHERE code=$1 AND (landlord_id=$2 OR landlord_id IS NULL)',
        [a.code, lid]
      )
      if (!exists) {
        await db.query(
          `INSERT INTO books_accounts (landlord_id, code, name, type, subtype, is_system)
           VALUES ($1,$2,$3,$4,$5,TRUE)`,
          [lid, a.code, a.name, a.type, a.subtype]
        )
        inserted++
      }
    }
    res.json({ success: true, data: { inserted, message: `${inserted} accounts added` } })
  } catch (e) { next(e) }
})

// ════════════════════════════════════════
// EMPLOYEES
// ════════════════════════════════════════

booksRouter.get('/employees', async (req, res, next) => {
  try {
    const lid = landlordScope(req.user)
    const { rows } = await db.query(
      `SELECT * FROM books_employees WHERE (landlord_id=$1 OR $1 IS NULL) ORDER BY last_name,first_name`,
      [lid]
    )
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

booksRouter.post('/employees', async (req, res, next) => {
  try {
    const lid = landlordScope(req.user)
    const { firstName, lastName, email, phone, address, ssnLast4, payType, payRate,
            payFrequency, filingStatus, federalAllowances, azWithholdingPct,
            title, department, startDate } = req.body
    if (!firstName || !lastName || !payType || payRate === undefined)
      throw new AppError(400, 'firstName, lastName, payType, payRate required')
    const { rows: [emp] } = await db.query(
      `INSERT INTO books_employees
         (landlord_id, first_name, last_name, email, phone, address, ssn_last4,
          pay_type, pay_rate, pay_frequency, filing_status, federal_allowances,
          az_withholding_pct, title, department, start_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [lid, firstName, lastName, email||null, phone||null, address||null, ssnLast4||null,
       payType, payRate, payFrequency||'biweekly', filingStatus||'single',
       federalAllowances||0, azWithholdingPct||2.5, title||null, department||null, startDate||null]
    )
    res.status(201).json({ success: true, data: emp })
  } catch (e) { next(e) }
})

booksRouter.patch('/employees/:id', async (req, res, next) => {
  try {
    const lid = landlordScope(req.user)
    const f = req.body
    const { rows: [emp] } = await db.query(
      `UPDATE books_employees SET
         first_name=COALESCE($1,first_name), last_name=COALESCE($2,last_name),
         email=COALESCE($3,email), phone=COALESCE($4,phone), title=COALESCE($5,title),
         department=COALESCE($6,department), pay_type=COALESCE($7,pay_type),
         pay_rate=COALESCE($8,pay_rate), pay_frequency=COALESCE($9,pay_frequency),
         status=COALESCE($10,status), updated_at=NOW()
       WHERE id=$11 AND (landlord_id=$12 OR $12 IS NULL) RETURNING *`,
      [f.firstName||null, f.lastName||null, f.email||null, f.phone||null,
       f.title||null, f.department||null, f.payType||null, f.payRate||null,
       f.payFrequency||null, f.status||null, req.params.id, lid]
    )
    if (!emp) throw new AppError(404, 'Employee not found')
    res.json({ success: true, data: emp })
  } catch (e) { next(e) }
})

// ════════════════════════════════════════
// CONTRACTORS
// ════════════════════════════════════════

booksRouter.get('/contractors', async (req, res, next) => {
  try {
    const lid = landlordScope(req.user)
    const { rows } = await db.query(
      `SELECT * FROM books_contractors WHERE (landlord_id=$1 OR $1 IS NULL) ORDER BY created_at DESC`,
      [lid]
    )
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

booksRouter.post('/contractors', async (req, res, next) => {
  try {
    const lid = landlordScope(req.user)
    const { firstName, lastName, businessName, email, phone, address, ein, ssnLast4,
            entityType, trade, payRate, payUnit, w9OnFile } = req.body
    const { rows: [con] } = await db.query(
      `INSERT INTO books_contractors
         (landlord_id, first_name, last_name, business_name, email, phone, address,
          ein, ssn_last4, entity_type, trade, pay_rate, pay_unit, w9_on_file)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [lid, firstName||null, lastName||null, businessName||null, email||null,
       phone||null, address||null, ein||null, ssnLast4||null,
       entityType||'individual', trade||null, payRate||null, payUnit||'project', w9OnFile||false]
    )
    res.status(201).json({ success: true, data: con })
  } catch (e) { next(e) }
})

booksRouter.patch('/contractors/:id', async (req, res, next) => {
  try {
    const lid = landlordScope(req.user)
    const f = req.body
    const { rows: [con] } = await db.query(
      `UPDATE books_contractors SET
         first_name=COALESCE($1,first_name), last_name=COALESCE($2,last_name),
         business_name=COALESCE($3,business_name), email=COALESCE($4,email),
         trade=COALESCE($5,trade), pay_rate=COALESCE($6,pay_rate),
         status=COALESCE($7,status), w9_on_file=COALESCE($8,w9_on_file), updated_at=NOW()
       WHERE id=$9 AND (landlord_id=$10 OR $10 IS NULL) RETURNING *`,
      [f.firstName||null, f.lastName||null, f.businessName||null, f.email||null,
       f.trade||null, f.payRate||null, f.status||null, f.w9OnFile??null,
       req.params.id, lid]
    )
    if (!con) throw new AppError(404, 'Contractor not found')
    res.json({ success: true, data: con })
  } catch (e) { next(e) }
})

// ════════════════════════════════════════
// VENDORS
// ════════════════════════════════════════

booksRouter.get('/vendors', async (req, res, next) => {
  try {
    const lid = landlordScope(req.user)
    const { rows } = await db.query(
      `SELECT * FROM books_vendors WHERE (landlord_id=$1 OR $1 IS NULL) AND status='active' ORDER BY name`,
      [lid]
    )
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

booksRouter.post('/vendors', async (req, res, next) => {
  try {
    const lid = landlordScope(req.user)
    const { name, contactName, email, phone, address, category, paymentTerms, accountNumber, taxId, notes } = req.body
    if (!name) throw new AppError(400, 'name is required')
    const { rows: [v] } = await db.query(
      `INSERT INTO books_vendors
         (landlord_id, name, contact_name, email, phone, address, category, payment_terms, account_number, tax_id, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [lid, name, contactName||null, email||null, phone||null, address||null,
       category||null, paymentTerms||'net30', accountNumber||null, taxId||null, notes||null]
    )
    res.status(201).json({ success: true, data: v })
  } catch (e) { next(e) }
})

booksRouter.patch('/vendors/:id', async (req, res, next) => {
  try {
    const lid = landlordScope(req.user)
    const f = req.body
    const { rows: [v] } = await db.query(
      `UPDATE books_vendors SET
         name=COALESCE($1,name), contact_name=COALESCE($2,contact_name),
         email=COALESCE($3,email), phone=COALESCE($4,phone),
         category=COALESCE($5,category), payment_terms=COALESCE($6,payment_terms),
         status=COALESCE($7,status), notes=COALESCE($8,notes), updated_at=NOW()
       WHERE id=$9 AND (landlord_id=$10 OR $10 IS NULL) RETURNING *`,
      [f.name||null, f.contactName||null, f.email||null, f.phone||null,
       f.category||null, f.paymentTerms||null, f.status||null, f.notes||null,
       req.params.id, lid]
    )
    if (!v) throw new AppError(404, 'Vendor not found')
    res.json({ success: true, data: v })
  } catch (e) { next(e) }
})

// ════════════════════════════════════════
// PAYROLL RUNS
// ════════════════════════════════════════

// Tax calculation helper
function calcTaxes(grossPay: number, filingStatus: string, azPct: number, ytdGross: number) {
  // Federal withholding — simplified % by filing status (production would use IRS tables)
  const fedRates: Record<string, number> = {
    single: 0.12, married: 0.10, married_higher: 0.12, head_of_household: 0.10
  }
  const fedRate = fedRates[filingStatus] || 0.12
  const federalTax = Math.max(0, grossPay * fedRate)

  // Social Security: 6.2% up to $168,600 annual wage base
  const SS_WAGE_BASE = 168600
  const ssEligible = Math.max(0, Math.min(grossPay, SS_WAGE_BASE - ytdGross))
  const ssTax = ssEligible * 0.062

  // Medicare: 1.45% (+ 0.9% over $200k)
  const medicareTax = grossPay * 0.0145 + (ytdGross + grossPay > 200000 ? grossPay * 0.009 : 0)

  // AZ state flat rate
  const stateTax = grossPay * (azPct / 100)

  const netPay = grossPay - federalTax - ssTax - medicareTax - stateTax

  return {
    federalTax: +federalTax.toFixed(2),
    ssTax: +ssTax.toFixed(2),
    medicareTax: +medicareTax.toFixed(2),
    stateTax: +stateTax.toFixed(2),
    netPay: +netPay.toFixed(2),
  }
}

// GET /api/books/payroll/runs
booksRouter.get('/payroll/runs', async (req, res, next) => {
  try {
    const lid = landlordScope(req.user)
    const { rows } = await db.query(
      `SELECT pr.*, COUNT(prl.id) as line_count
       FROM payroll_runs pr
       LEFT JOIN payroll_run_lines prl ON prl.run_id = pr.id
       WHERE (pr.landlord_id = $1 OR $1 IS NULL)
       GROUP BY pr.id
       ORDER BY pr.pay_date DESC`,
      [lid]
    )
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// GET /api/books/payroll/runs/:id
booksRouter.get('/payroll/runs/:id', async (req, res, next) => {
  try {
    const lid = landlordScope(req.user)
    const run = await queryOne<any>(
      'SELECT * FROM payroll_runs WHERE id=$1 AND (landlord_id=$2 OR $2 IS NULL)',
      [req.params.id, lid]
    )
    if (!run) throw new AppError(404, 'Run not found')
    const { rows: lines } = await db.query(
      `SELECT prl.*, e.first_name, e.last_name, e.title, e.pay_type as emp_pay_type,
              e.pay_rate, e.ytd_gross
       FROM payroll_run_lines prl
       JOIN books_employees e ON e.id = prl.employee_id
       WHERE prl.run_id = $1`,
      [req.params.id]
    )
    res.json({ success: true, data: { ...run, lines } })
  } catch (e) { next(e) }
})

// POST /api/books/payroll/runs — calculate draft run
booksRouter.post('/payroll/runs', async (req, res, next) => {
  try {
    const lid = landlordScope(req.user)
    const { periodStart, periodEnd, payDate, payFrequency, employeeIds, hoursMap = {} } = req.body
    if (!periodStart || !periodEnd || !payDate || !payFrequency || !employeeIds?.length)
      throw new AppError(400, 'periodStart, periodEnd, payDate, payFrequency, employeeIds required')

    // Fetch selected employees
    const placeholders = employeeIds.map((_: any, i: number) => `$${i + 2}`).join(',')
    const { rows: employees } = await db.query(
      `SELECT * FROM books_employees WHERE id IN (${placeholders}) AND (landlord_id=$1 OR $1 IS NULL) AND status='active'`,
      [lid, ...employeeIds]
    )
    if (!employees.length) throw new AppError(400, 'No active employees found')

    // Calculate gross per period
    const periods: Record<string, number> = { weekly: 52, biweekly: 26, semimonthly: 24, monthly: 12 }
    const periodsPerYear = periods[payFrequency] || 26

    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const { rows: [run] } = await client.query(
        `INSERT INTO payroll_runs (landlord_id, period_start, period_end, pay_date, pay_frequency, status)
         VALUES ($1,$2,$3,$4,$5,'draft') RETURNING *`,
        [lid, periodStart, periodEnd, payDate, payFrequency]
      )

      let totalGross = 0, totalFed = 0, totalState = 0, totalSS = 0, totalMedicare = 0, totalNet = 0

      for (const emp of employees) {
        const hours = hoursMap[emp.id] || null
        let grossPay = 0
        if (emp.pay_type === 'salary') {
          grossPay = +emp.pay_rate / periodsPerYear
        } else {
          // Hourly — require hours
          const h = hours || (40 * (payFrequency === 'weekly' ? 1 : 2))
          grossPay = +emp.pay_rate * h
        }
        grossPay = +grossPay.toFixed(2)

        const taxes = calcTaxes(grossPay, emp.filing_status || 'single', +emp.az_withholding_pct || 2.5, +emp.ytd_gross || 0)

        await client.query(
          `INSERT INTO payroll_run_lines
             (run_id, employee_id, pay_type, hours_worked, gross_pay,
              federal_tax, state_tax, ss_tax, medicare_tax, net_pay)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [run.id, emp.id, emp.pay_type, hours, grossPay,
           taxes.federalTax, taxes.stateTax, taxes.ssTax, taxes.medicareTax, taxes.netPay]
        )

        totalGross += grossPay; totalFed += taxes.federalTax; totalState += taxes.stateTax
        totalSS += taxes.ssTax; totalMedicare += taxes.medicareTax; totalNet += taxes.netPay
      }

      await client.query(
        `UPDATE payroll_runs SET
           total_gross=$1, total_federal_tax=$2, total_state_tax=$3,
           total_ss=$4, total_medicare=$5, total_net=$6, employee_count=$7
         WHERE id=$8`,
        [+totalGross.toFixed(2), +totalFed.toFixed(2), +totalState.toFixed(2),
         +totalSS.toFixed(2), +totalMedicare.toFixed(2), +totalNet.toFixed(2),
         employees.length, run.id]
      )

      await client.query('COMMIT')
      const { rows: [finalRun] } = await db.query('SELECT * FROM payroll_runs WHERE id=$1', [run.id])
      const { rows: lines } = await db.query(
        `SELECT prl.*, e.first_name, e.last_name, e.title FROM payroll_run_lines prl
         JOIN books_employees e ON e.id = prl.employee_id WHERE prl.run_id=$1`, [run.id]
      )
      res.status(201).json({ success: true, data: { ...finalRun, lines } })
    } catch (e) { await client.query('ROLLBACK'); throw e }
    finally { client.release() }
  } catch (e) { next(e) }
})

// POST /api/books/payroll/runs/:id/approve
booksRouter.post('/payroll/runs/:id/approve', async (req, res, next) => {
  try {
    const lid = landlordScope(req.user)
    const run = await queryOne<any>(
      'SELECT * FROM payroll_runs WHERE id=$1 AND (landlord_id=$2 OR $2 IS NULL)',
      [req.params.id, lid]
    )
    if (!run) throw new AppError(404, 'Run not found')
    if (run.status !== 'draft') throw new AppError(400, `Run is already ${run.status}`)

    const client = await db.connect()
    try {
      await client.query('BEGIN')
      // Update run status
      await client.query(
        `UPDATE payroll_runs SET status='approved', approved_at=NOW(), approved_by=$1, updated_at=NOW() WHERE id=$2`,
        [req.user!.userId, req.params.id]
      )
      // Update YTD on each employee
      const { rows: lines } = await client.query(
        'SELECT * FROM payroll_run_lines WHERE run_id=$1', [req.params.id]
      )
      for (const line of lines) {
        await client.query(
          `UPDATE books_employees SET
             ytd_gross = ytd_gross + $1,
             ytd_federal_tax = ytd_federal_tax + $2,
             ytd_state_tax = ytd_state_tax + $3,
             ytd_ss = ytd_ss + $4,
             ytd_medicare = ytd_medicare + $5,
             ytd_net = ytd_net + $6,
             updated_at = NOW()
           WHERE id = $7`,
          [line.gross_pay, line.federal_tax, line.state_tax, line.ss_tax, line.medicare_tax, line.net_pay, line.employee_id]
        )
      }
      await client.query('COMMIT')
      const { rows: [updated] } = await db.query('SELECT * FROM payroll_runs WHERE id=$1', [req.params.id])
      res.json({ success: true, data: updated })
    } catch (e) { await client.query('ROLLBACK'); throw e }
    finally { client.release() }
  } catch (e) { next(e) }
})

// POST /api/books/payroll/runs/:id/void
booksRouter.post('/payroll/runs/:id/void', async (req, res, next) => {
  try {
    const lid = landlordScope(req.user)
    const run = await queryOne<any>(
      'SELECT * FROM payroll_runs WHERE id=$1 AND (landlord_id=$2 OR $2 IS NULL)',
      [req.params.id, lid]
    )
    if (!run) throw new AppError(404, 'Run not found')
    if (run.status === 'voided') throw new AppError(400, 'Already voided')

    const client = await db.connect()
    try {
      await client.query('BEGIN')
      // If approved, reverse YTD
      if (run.status === 'approved') {
        const { rows: lines } = await client.query('SELECT * FROM payroll_run_lines WHERE run_id=$1', [req.params.id])
        for (const line of lines) {
          await client.query(
            `UPDATE books_employees SET
               ytd_gross = GREATEST(0, ytd_gross - $1),
               ytd_federal_tax = GREATEST(0, ytd_federal_tax - $2),
               ytd_state_tax = GREATEST(0, ytd_state_tax - $3),
               ytd_ss = GREATEST(0, ytd_ss - $4),
               ytd_medicare = GREATEST(0, ytd_medicare - $5),
               ytd_net = GREATEST(0, ytd_net - $6),
               updated_at = NOW()
             WHERE id=$7`,
            [line.gross_pay, line.federal_tax, line.state_tax, line.ss_tax, line.medicare_tax, line.net_pay, line.employee_id]
          )
        }
      }
      await client.query(
        `UPDATE payroll_runs SET status='voided', voided_at=NOW(), updated_at=NOW() WHERE id=$1`,
        [req.params.id]
      )
      await client.query('COMMIT')
      res.json({ success: true, data: { message: 'Run voided' } })
    } catch (e) { await client.query('ROLLBACK'); throw e }
    finally { client.release() }
  } catch (e) { next(e) }
})


// ════════════════════════════════════════
// BOOKKEEPER MANAGEMENT
// ════════════════════════════════════════

// GET /api/books/bookkeeper/clients — list all clients for logged-in bookkeeper
booksRouter.get('/bookkeeper/clients', async (req, res, next) => {
  try {
    if (req.user?.role !== 'bookkeeper' && req.user?.role !== 'admin' && req.user?.role !== 'super_admin')
      throw new AppError(403, 'Bookkeeper access required')

    const userId = req.user.role === 'bookkeeper' ? req.user.userId : null

    const { rows } = await db.query(
      `SELECT
          ba.id AS access_id, ba.permissions, ba.status, ba.created_at AS access_since,
          l.id AS landlord_id, l.business_name, l.volume_tier,
          u.first_name, u.last_name, u.email,
          (SELECT COUNT(*) FROM books_employees WHERE landlord_id = l.id AND status='active') AS employee_count,
          (SELECT COUNT(*) FROM books_contractors WHERE landlord_id = l.id AND status='active') AS contractor_count,
          (SELECT COUNT(*) FROM payroll_runs WHERE landlord_id = l.id AND status='approved') AS payroll_run_count
        FROM books_access ba
        JOIN landlords l ON l.id = ba.landlord_id
        JOIN users u ON u.id = l.user_id
        WHERE ($1::uuid IS NULL OR ba.bookkeeper_user_id = $1)
        AND ba.status = 'active'
        ORDER BY l.business_name ASC`,
      [userId]
    )
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// GET /api/books/bookkeeper/all — admin: list all bookkeepers
booksRouter.get('/bookkeeper/all', async (req, res, next) => {
  try {
    if (req.user?.role !== 'admin' && req.user?.role !== 'super_admin')
      throw new AppError(403, 'Admin required')
    const { rows } = await db.query(
      `SELECT u.id, u.email, u.first_name, u.last_name, u.created_at,
          COUNT(ba.id) AS client_count
        FROM users u
        LEFT JOIN books_access ba ON ba.bookkeeper_user_id = u.id AND ba.status = 'active'
        WHERE u.role = 'bookkeeper'
        GROUP BY u.id ORDER BY u.last_name`
    )
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// POST /api/books/bookkeeper/invite — admin: create bookkeeper user + assign clients
booksRouter.post('/bookkeeper/invite', async (req, res, next) => {
  try {
    if (req.user?.role !== 'admin' && req.user?.role !== 'super_admin' && req.user?.role !== 'landlord')
      throw new AppError(403, 'Admin or Landlord required')

    const { email, firstName, lastName, password, landlordIds } = req.body
    if (!email || !firstName || !lastName || !password)
      throw new AppError(400, 'email, firstName, lastName, password required')

    const bcrypt = require('bcryptjs')
    const hash = await bcrypt.hash(password, 12)
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      // Create or update user with bookkeeper role
      const { rows: [user] } = await client.query(
        `INSERT INTO users (email, password_hash, role, first_name, last_name)
         VALUES ($1,$2,'bookkeeper',$3,$4)
         ON CONFLICT (email) DO UPDATE SET role='bookkeeper', first_name=$3, last_name=$4
         RETURNING id, email, first_name, last_name, role`,
        [email, hash, firstName, lastName]
      )
      // Assign clients
      const assigned = []
      for (const lid of (landlordIds || [])) {
        await client.query(
          `INSERT INTO books_access (bookkeeper_user_id, landlord_id, invited_by)
           VALUES ($1,$2,$3) ON CONFLICT (bookkeeper_user_id, landlord_id) DO UPDATE SET status='active'`,
          [user.id, lid, req.user.userId]
        )
        assigned.push(lid)
      }
      await client.query('COMMIT')
      res.status(201).json({ success: true, data: { user, clientsAssigned: assigned.length } })
    } catch (e) { await client.query('ROLLBACK'); throw e }
    finally { client.release() }
  } catch (e) { next(e) }
})

// POST /api/books/bookkeeper/assign — assign existing bookkeeper to a landlord
booksRouter.post('/bookkeeper/assign', async (req, res, next) => {
  try {
    if (req.user?.role !== 'admin' && req.user?.role !== 'super_admin' && req.user?.role !== 'landlord')
      throw new AppError(403, 'Admin or Landlord required')
    const { bookkeeperUserId, landlordId, permissions } = req.body
    if (!bookkeeperUserId || !landlordId) throw new AppError(400, 'bookkeeperUserId and landlordId required')
    const { rows: [access] } = await db.query(
      `INSERT INTO books_access (bookkeeper_user_id, landlord_id, permissions, invited_by)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (bookkeeper_user_id, landlord_id) DO UPDATE SET status='active', permissions=COALESCE($3,books_access.permissions)
       RETURNING *`,
      [bookkeeperUserId, landlordId, permissions ? JSON.stringify(permissions) : null, req.user.userId]
    )
    res.json({ success: true, data: access })
  } catch (e) { next(e) }
})

// DELETE /api/books/bookkeeper/revoke — remove bookkeeper from a client
booksRouter.delete('/bookkeeper/revoke', async (req, res, next) => {
  try {
    if (req.user?.role !== 'admin' && req.user?.role !== 'super_admin' && req.user?.role !== 'landlord')
      throw new AppError(403, 'Admin or Landlord required')
    const { bookkeeperUserId, landlordId } = req.body
    await db.query(
      `UPDATE books_access SET status='revoked', updated_at=NOW()
       WHERE bookkeeper_user_id=$1 AND landlord_id=$2`,
      [bookkeeperUserId, landlordId]
    )
    res.json({ success: true })
  } catch (e) { next(e) }
})


// ════════════════════════════════════════
// BOOKKEEPER MANAGEMENT
// ════════════════════════════════════════

// GET /api/books/bookkeeper/clients — list all clients for logged-in bookkeeper
booksRouter.get('/bookkeeper/clients', async (req, res, next) => {
  try {
    if (req.user?.role !== 'bookkeeper' && req.user?.role !== 'admin' && req.user?.role !== 'super_admin')
      throw new AppError(403, 'Bookkeeper access required')

    const userId = req.user.role === 'bookkeeper' ? req.user.userId : null

    const { rows } = await db.query(
      `SELECT
          ba.id AS access_id, ba.permissions, ba.status, ba.created_at AS access_since,
          l.id AS landlord_id, l.business_name, l.volume_tier,
          u.first_name, u.last_name, u.email,
          (SELECT COUNT(*) FROM books_employees WHERE landlord_id = l.id AND status='active') AS employee_count,
          (SELECT COUNT(*) FROM books_contractors WHERE landlord_id = l.id AND status='active') AS contractor_count,
          (SELECT COUNT(*) FROM payroll_runs WHERE landlord_id = l.id AND status='approved') AS payroll_run_count
        FROM books_access ba
        JOIN landlords l ON l.id = ba.landlord_id
        JOIN users u ON u.id = l.user_id
        WHERE ($1::uuid IS NULL OR ba.bookkeeper_user_id = $1)
        AND ba.status = 'active'
        ORDER BY l.business_name ASC`,
      [userId]
    )
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// GET /api/books/bookkeeper/all — admin: list all bookkeepers
booksRouter.get('/bookkeeper/all', async (req, res, next) => {
  try {
    if (req.user?.role !== 'admin' && req.user?.role !== 'super_admin')
      throw new AppError(403, 'Admin required')
    const { rows } = await db.query(
      `SELECT u.id, u.email, u.first_name, u.last_name, u.created_at,
          COUNT(ba.id) AS client_count
        FROM users u
        LEFT JOIN books_access ba ON ba.bookkeeper_user_id = u.id AND ba.status = 'active'
        WHERE u.role = 'bookkeeper'
        GROUP BY u.id ORDER BY u.last_name`
    )
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// POST /api/books/bookkeeper/invite — admin: create bookkeeper user + assign clients
booksRouter.post('/bookkeeper/invite', async (req, res, next) => {
  try {
    if (req.user?.role !== 'admin' && req.user?.role !== 'super_admin' && req.user?.role !== 'landlord')
      throw new AppError(403, 'Admin or Landlord required')

    const { email, firstName, lastName, password, landlordIds } = req.body
    if (!email || !firstName || !lastName || !password)
      throw new AppError(400, 'email, firstName, lastName, password required')

    const bcrypt = require('bcryptjs')
    const hash = await bcrypt.hash(password, 12)
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      // Create or update user with bookkeeper role
      const { rows: [user] } = await client.query(
        `INSERT INTO users (email, password_hash, role, first_name, last_name)
         VALUES ($1,$2,'bookkeeper',$3,$4)
         ON CONFLICT (email) DO UPDATE SET role='bookkeeper', first_name=$3, last_name=$4
         RETURNING id, email, first_name, last_name, role`,
        [email, hash, firstName, lastName]
      )
      // Assign clients
      const assigned = []
      for (const lid of (landlordIds || [])) {
        await client.query(
          `INSERT INTO books_access (bookkeeper_user_id, landlord_id, invited_by)
           VALUES ($1,$2,$3) ON CONFLICT (bookkeeper_user_id, landlord_id) DO UPDATE SET status='active'`,
          [user.id, lid, req.user.userId]
        )
        assigned.push(lid)
      }
      await client.query('COMMIT')
      res.status(201).json({ success: true, data: { user, clientsAssigned: assigned.length } })
    } catch (e) { await client.query('ROLLBACK'); throw e }
    finally { client.release() }
  } catch (e) { next(e) }
})

// POST /api/books/bookkeeper/assign — assign existing bookkeeper to a landlord
booksRouter.post('/bookkeeper/assign', async (req, res, next) => {
  try {
    if (req.user?.role !== 'admin' && req.user?.role !== 'super_admin' && req.user?.role !== 'landlord')
      throw new AppError(403, 'Admin or Landlord required')
    const { bookkeeperUserId, landlordId, permissions } = req.body
    if (!bookkeeperUserId || !landlordId) throw new AppError(400, 'bookkeeperUserId and landlordId required')
    const { rows: [access] } = await db.query(
      `INSERT INTO books_access (bookkeeper_user_id, landlord_id, permissions, invited_by)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (bookkeeper_user_id, landlord_id) DO UPDATE SET status='active', permissions=COALESCE($3,books_access.permissions)
       RETURNING *`,
      [bookkeeperUserId, landlordId, permissions ? JSON.stringify(permissions) : null, req.user.userId]
    )
    res.json({ success: true, data: access })
  } catch (e) { next(e) }
})

// DELETE /api/books/bookkeeper/revoke — remove bookkeeper from a client
booksRouter.delete('/bookkeeper/revoke', async (req, res, next) => {
  try {
    if (req.user?.role !== 'admin' && req.user?.role !== 'super_admin' && req.user?.role !== 'landlord')
      throw new AppError(403, 'Admin or Landlord required')
    const { bookkeeperUserId, landlordId } = req.body
    await db.query(
      `UPDATE books_access SET status='revoked', updated_at=NOW()
       WHERE bookkeeper_user_id=$1 AND landlord_id=$2`,
      [bookkeeperUserId, landlordId]
    )
    res.json({ success: true })
  } catch (e) { next(e) }
})
