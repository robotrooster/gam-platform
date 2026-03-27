import { Router } from 'express'
import { query, queryOne } from '../db'
import { requireAuth, requireLandlord } from '../middleware/auth'
import crypto from 'crypto'

export const teamRouter = Router()
teamRouter.use(requireAuth)

// GET /team — list team members for landlord
teamRouter.get('/', requireLandlord, async (req, res, next) => {
  try {
    const landlord = await queryOne<any>('SELECT id FROM landlords WHERE user_id=$1', [req.user!.userId])
    if (!landlord) return res.status(404).json({ success: false, error: 'Landlord not found' })

    const members = await query<any>(`
      SELECT 
        tm.id, tm.role, tm.status, tm.invite_email, tm.created_at,
        u.id as user_id, u.first_name, u.last_name, u.email, u.phone,
        COALESCE(
          json_agg(
            json_build_object('id', p.id, 'name', p.name)
          ) FILTER (WHERE p.id IS NOT NULL), '[]'
        ) as properties
      FROM team_members tm
      LEFT JOIN users u ON u.id = tm.user_id
      LEFT JOIN team_property_access tpa ON tpa.team_member_id = tm.id
      LEFT JOIN properties p ON p.id = tpa.property_id
      WHERE tm.landlord_id = $1
      GROUP BY tm.id, u.id
      ORDER BY tm.created_at DESC
    `, [landlord.id])

    res.json({ success: true, data: members })
  } catch (e) { next(e) }
})

// POST /team — invite a team member
teamRouter.post('/', requireLandlord, async (req, res, next) => {
  try {
    const { email, role, propertyIds = [], firstName, lastName } = req.body
    if (!email || !role) return res.status(400).json({ success: false, error: 'Email and role required' })
    if (!['property_manager','onsite_manager','maintenance'].includes(role)) {
      return res.status(400).json({ success: false, error: 'Invalid role' })
    }

    const landlord = await queryOne<any>('SELECT id FROM landlords WHERE user_id=$1', [req.user!.userId])
    if (!landlord) return res.status(404).json({ success: false, error: 'Landlord not found' })

    // Check if user already exists
    let user = await queryOne<any>('SELECT id FROM users WHERE email=$1', [email])
    const inviteToken = crypto.randomBytes(32).toString('hex')

    if (!user) {
      // Create placeholder user — they'll set password via invite link
      const tempHash = '$2b$10$placeholder' // replaced on first login
      user = await queryOne<any>(`
        INSERT INTO users (email, password_hash, role, first_name, last_name)
        VALUES ($1, $2, $3, $4, $5) RETURNING id
      `, [email, tempHash, role, firstName || email.split('@')[0], lastName || ''])
    } else {
      // Update their role
      await query('UPDATE users SET role=$1 WHERE id=$2', [role, user.id])
    }

    // Check for existing team membership
    const existing = await queryOne<any>(
      'SELECT id FROM team_members WHERE landlord_id=$1 AND user_id=$2',
      [landlord.id, user!.id]
    )
    if (existing) return res.status(409).json({ success: false, error: 'Already a team member' })

    // Create team member record
    const member = await queryOne<any>(`
      INSERT INTO team_members (landlord_id, user_id, role, status, invite_token, invite_email)
      VALUES ($1, $2, $3, 'pending', $4, $5) RETURNING *
    `, [landlord.id, user!.id, role, inviteToken, email])

    // Assign property access
    if (propertyIds.length > 0) {
      for (const propId of propertyIds) {
        await query(
          'INSERT INTO team_property_access (team_member_id, property_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [member!.id, propId]
        )
      }
    }

    // TODO: Send invite email with inviteToken
    console.log(`[TEAM] Invite sent to ${email} — token: ${inviteToken}`)

    res.json({ success: true, data: { ...member, inviteToken } })
  } catch (e) { next(e) }
})

// PATCH /team/:id — update role or status
teamRouter.patch('/:id', requireLandlord, async (req, res, next) => {
  try {
    const landlord = await queryOne<any>('SELECT id FROM landlords WHERE user_id=$1', [req.user!.userId])
    if (!landlord) return res.status(404).json({ success: false, error: 'Not found' })

    const { role, status, propertyIds } = req.body
    const member = await queryOne<any>(
      'SELECT * FROM team_members WHERE id=$1 AND landlord_id=$2',
      [req.params.id, landlord.id]
    )
    if (!member) return res.status(404).json({ success: false, error: 'Team member not found' })

    if (role) await query('UPDATE team_members SET role=$1 WHERE id=$2', [role, member.id])
    if (status) await query('UPDATE team_members SET status=$1 WHERE id=$2', [status, member.id])
    if (role) await query('UPDATE users SET role=$1 WHERE id=$2', [role, member.user_id])

    // Update property access if provided
    if (propertyIds !== undefined) {
      await query('DELETE FROM team_property_access WHERE team_member_id=$1', [member.id])
      for (const propId of propertyIds) {
        await query(
          'INSERT INTO team_property_access (team_member_id, property_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [member.id, propId]
        )
      }
    }

    const updated = await queryOne<any>('SELECT * FROM team_members WHERE id=$1', [member.id])
    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

// DELETE /team/:id — remove team member
teamRouter.delete('/:id', requireLandlord, async (req, res, next) => {
  try {
    const landlord = await queryOne<any>('SELECT id FROM landlords WHERE user_id=$1', [req.user!.userId])
    if (!landlord) return res.status(404).json({ success: false, error: 'Not found' })

    const member = await queryOne<any>(
      'SELECT * FROM team_members WHERE id=$1 AND landlord_id=$2',
      [req.params.id, landlord.id]
    )
    if (!member) return res.status(404).json({ success: false, error: 'Not found' })

    // Reset user role to tenant (safest default)
    await query('UPDATE users SET role=$1 WHERE id=$2', ['tenant', member.user_id])
    await query('DELETE FROM team_members WHERE id=$1', [member.id])

    res.json({ success: true, data: { deleted: true } })
  } catch (e) { next(e) }
})

// GET /team/properties — get properties for assignment
teamRouter.get('/properties', requireLandlord, async (req, res, next) => {
  try {
    const landlord = await queryOne<any>('SELECT id FROM landlords WHERE user_id=$1', [req.user!.userId])
    if (!landlord) return res.status(404).json({ success: false, error: 'Not found' })
    const props = await query<any>('SELECT id, name, street1, city FROM properties WHERE landlord_id=$1', [landlord.id])
    res.json({ success: true, data: props })
  } catch (e) { next(e) }
})
