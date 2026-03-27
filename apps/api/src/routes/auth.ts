import { Router } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { z } from 'zod'
import { db, queryOne } from '../db'
import { UserRole } from '@gam/shared'
import { requireAuth } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'

export const authRouter = Router()

const registerSchema = z.object({
  email:     z.string().email(),
  password:  z.string().min(8),
  firstName: z.string().min(1),
  lastName:  z.string().min(1),
  phone:     z.string().optional(),
  role:      z.enum([UserRole.LANDLORD, UserRole.TENANT]),
})

const loginSchema = z.object({
  email:    z.string().email(),
  password: z.string(),
})

function signToken(payload: object) {
  return jwt.sign(payload, process.env.JWT_SECRET!, { expiresIn: '7d' })
}

// POST /api/auth/register
authRouter.post('/register', async (req, res, next) => {
  try {
    const body = registerSchema.parse(req.body)
    const exists = await queryOne('SELECT id FROM users WHERE email = $1', [body.email])
    if (exists) throw new AppError(409, 'Email already registered')

    const hash = await bcrypt.hash(body.password, 12)
    const client = await db.connect()
    try {
      await client.query('BEGIN')

      const [user] = await client.query(
        `INSERT INTO users (email, password_hash, role, first_name, last_name, phone)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, email, role, first_name, last_name`,
        [body.email, hash, body.role, body.firstName, body.lastName, body.phone ?? null]
      ).then(r => r.rows)

      let profileId: string
      if (body.role === UserRole.LANDLORD) {
        const [l] = await client.query(
          `INSERT INTO landlords (user_id) VALUES ($1) RETURNING id`, [user.id]
        ).then(r => r.rows)
        profileId = l.id
      } else {
        const [t] = await client.query(
          `INSERT INTO tenants (user_id) VALUES ($1) RETURNING id`, [user.id]
        ).then(r => r.rows)
        profileId = t.id
      }

      await client.query('COMMIT')

      const token = signToken({ userId: user.id, role: user.role, email: user.email, profileId })
      res.status(201).json({
        success: true,
        data: { token, user: { id: user.id, email: user.email, role: user.role,
          firstName: user.first_name, lastName: user.last_name, profileId } }
      })
    } catch (e) { await client.query('ROLLBACK'); throw e }
    finally { client.release() }
  } catch (e) { next(e) }
})

// POST /api/auth/login
authRouter.post('/login', async (req, res, next) => {
  try {
    const { email, password } = loginSchema.parse(req.body)
    const user = await queryOne<any>(
      `SELECT u.*,
        COALESCE(l.id, t.id, tm.landlord_id) AS profile_id,
        tm.landlord_id AS team_landlord_id,
        tm.permissions AS team_permissions,
        tm.id AS team_member_id,
        tm.status AS team_status
       FROM users u
       LEFT JOIN landlords l ON l.user_id = u.id
       LEFT JOIN tenants   t ON t.user_id = u.id
       LEFT JOIN team_members tm ON tm.user_id = u.id AND tm.status = 'active'
       WHERE u.email = $1`, [email]
    )
    if (!user) throw new AppError(401, 'Invalid credentials')
    const valid = await bcrypt.compare(password, user.password_hash)
    if (!valid) throw new AppError(401, 'Invalid credentials')

    await db.query(`UPDATE users SET last_login_at = NOW() WHERE id = $1`, [user.id])
    // Block inactive team members
    if (['property_manager','onsite_manager','maintenance'].includes(user.role) && user.team_status !== 'active' && user.team_status !== null) {
      throw new AppError(403, 'Your account has been deactivated. Contact your landlord.')
    }

    const token = signToken({
      userId: user.id, role: user.role, email: user.email,
      profileId: user.profile_id,
      landlordId: user.team_landlord_id || null,
      permissions: user.team_permissions || null,
    })
    res.json({
      success: true,
      data: { token, user: {
        id: user.id, email: user.email, role: user.role,
        firstName: user.first_name, lastName: user.last_name,
        profileId: user.profile_id,
        landlordId: user.team_landlord_id || null,
        permissions: user.team_permissions || null,
      }}
    })
  } catch (e) { next(e) }
})

// GET /api/auth/me
authRouter.get('/me', requireAuth, async (req, res, next) => {
  try {
    const user = await queryOne<any>(
      `SELECT u.id, u.email, u.role, u.first_name, u.last_name, u.phone,
         COALESCE(l.id, t.id) AS profile_id,
         l.business_name, l.onboarding_complete, l.stripe_bank_verified,
         t.ach_verified, t.on_time_pay_enrolled, t.credit_reporting_enrolled
       FROM users u
       LEFT JOIN landlords l ON l.user_id = u.id
       LEFT JOIN tenants   t ON t.user_id = u.id
       WHERE u.id = $1`, [req.user!.userId]
    )
    if (!user) throw new AppError(404, 'User not found')
    res.json({ success: true, data: user })
  } catch (e) { next(e) }
})

// POST /api/auth/refresh
authRouter.post('/refresh', requireAuth, (req, res) => {
  const token = signToken(req.user!)
  res.json({ success: true, data: { token } })
})

// PATCH /api/auth/me — update user profile
authRouter.patch('/me', requireAuth, async (req, res, next) => {
  try {
    const { firstName, lastName, phone } = req.body
    await query(`UPDATE users SET first_name=COALESCE($1,first_name), last_name=COALESCE($2,last_name), phone=COALESCE($3,phone), updated_at=NOW() WHERE id=$4`,
      [firstName||null, lastName||null, phone||null, req.user!.userId])
    const user = await queryOne<any>('SELECT * FROM users WHERE id=$1', [req.user!.userId])
    res.json({ success: true, data: user })
  } catch(e) { next(e) }
})
