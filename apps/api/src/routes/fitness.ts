import { Router, Request, Response } from 'express';
import { db } from '../db';
import { requireAuth } from '../middleware/auth';

const router = Router();
const pool = db;

// Canonical pattern: requireAuth populates req.user via the global Express
// Request augmentation in middleware/auth.ts. No local AuthRequest needed.
const auth = requireAuth;

const adminAuth = (req: Request, res: Response, next: any) => {
  auth(req, res, () => {
    if (req.user?.role !== 'admin' && req.user?.role !== 'super_admin') return res.json({ success: false, error: 'Admin access required' });
    next();
  });
};

router.get('/profile', auth, async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query('SELECT * FROM fitness_profiles WHERE user_id = $1', [req.user!.userId]);
    res.json({ success: true, data: rows[0] || null });
  } catch (e: any) { res.json({ success: false, error: e.message }); }
});

router.post('/profile', auth, async (req: Request, res: Response) => {
  const { height_inches, weight_lbs, age, goal_physique, target_weight_lbs, experience_level, injuries, available_equipment, days_per_week, minutes_per_session, fitness_goal, onboarding_complete } = req.body;
  try {
    const { rows } = await pool.query(`INSERT INTO fitness_profiles (user_id, height_inches, weight_lbs, age, goal_physique, target_weight_lbs, experience_level, injuries, available_equipment, days_per_week, minutes_per_session, fitness_goal, onboarding_complete, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW()) ON CONFLICT (user_id) DO UPDATE SET height_inches=EXCLUDED.height_inches, weight_lbs=EXCLUDED.weight_lbs, age=EXCLUDED.age, goal_physique=EXCLUDED.goal_physique, target_weight_lbs=EXCLUDED.target_weight_lbs, experience_level=EXCLUDED.experience_level, injuries=EXCLUDED.injuries, available_equipment=EXCLUDED.available_equipment, days_per_week=EXCLUDED.days_per_week, minutes_per_session=EXCLUDED.minutes_per_session, fitness_goal=EXCLUDED.fitness_goal, onboarding_complete=EXCLUDED.onboarding_complete, updated_at=NOW() RETURNING *`,
      [req.user!.userId, height_inches, weight_lbs, age, goal_physique, target_weight_lbs, experience_level, injuries, available_equipment, days_per_week, minutes_per_session, fitness_goal, onboarding_complete ?? false]);
    res.json({ success: true, data: rows[0] });
  } catch (e: any) { res.json({ success: false, error: e.message }); }
});

router.get('/routines', auth, async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query('SELECT * FROM fitness_routines WHERE user_id = $1 ORDER BY created_at DESC', [req.user!.userId]);
    res.json({ success: true, data: rows });
  } catch (e: any) { res.json({ success: false, error: e.message }); }
});

router.get('/routines/:id/full', auth, async (req: Request, res: Response) => {
  try {
    const { rows: routineRows } = await pool.query('SELECT * FROM fitness_routines WHERE id = $1 AND user_id = $2', [req.params.id, req.user!.userId]);
    if (!routineRows[0]) return res.json({ success: false, error: 'Not found' });
    const { rows: days } = await pool.query('SELECT * FROM fitness_days WHERE routine_id = $1 ORDER BY sort_order', [req.params.id]);
    for (const day of days) {
      const { rows: sections } = await pool.query('SELECT * FROM fitness_sections WHERE day_id = $1 ORDER BY sort_order', [day.id]);
      for (const section of sections) {
        const { rows: exercises } = await pool.query('SELECT * FROM fitness_exercises WHERE section_id = $1 ORDER BY sort_order', [section.id]);
        (section as any).exercises = exercises;
      }
      (day as any).sections = sections;
    }
    res.json({ success: true, data: { ...routineRows[0], days } });
  } catch (e: any) { res.json({ success: false, error: e.message }); }
});

router.post('/routines', auth, async (req: Request, res: Response) => {
  const { name, description, days } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [routine] } = await client.query('INSERT INTO fitness_routines (user_id, name, description) VALUES ($1,$2,$3) RETURNING *', [req.user!.userId, name, description]);
    if (days && Array.isArray(days)) {
      for (let di = 0; di < days.length; di++) {
        const day = days[di];
        const { rows: [dayRow] } = await client.query('INSERT INTO fitness_days (routine_id, day_number, title, subtitle, sort_order) VALUES ($1,$2,$3,$4,$5) RETURNING *', [routine.id, day.day_number || di + 1, day.title, day.subtitle, di]);
        if (day.sections && Array.isArray(day.sections)) {
          for (let si = 0; si < day.sections.length; si++) {
            const section = day.sections[si];
            const { rows: [sectionRow] } = await client.query('INSERT INTO fitness_sections (day_id, label, sort_order) VALUES ($1,$2,$3) RETURNING *', [dayRow.id, section.label, si]);
            if (section.exercises && Array.isArray(section.exercises)) {
              for (let ei = 0; ei < section.exercises.length; ei++) {
                const ex = section.exercises[ei];
                await client.query('INSERT INTO fitness_exercises (section_id, name, sets, reps_min, reps_max, notes, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7)', [sectionRow.id, ex.name, ex.sets, ex.reps_min, ex.reps_max, ex.notes, ei]);
              }
            }
          }
        }
      }
    }
    await client.query('COMMIT');
    res.json({ success: true, data: routine });
  } catch (e: any) { await client.query('ROLLBACK'); res.json({ success: false, error: e.message }); }
  finally { client.release(); }
});

router.delete('/routines/:id', auth, async (req: Request, res: Response) => {
  try {
    await pool.query('DELETE FROM fitness_routines WHERE id = $1 AND user_id = $2', [req.params.id, req.user!.userId]);
    res.json({ success: true });
  } catch (e: any) { res.json({ success: false, error: e.message }); }
});

router.post('/logs', auth, async (req: Request, res: Response) => {
  const { day_id, day_title, logged_date } = req.body;
  try {
    const { rows } = await pool.query('INSERT INTO fitness_workout_logs (user_id, day_id, day_title, logged_date) VALUES ($1,$2,$3,$4) RETURNING *', [req.user!.userId, day_id, day_title, logged_date || new Date().toISOString().split('T')[0]]);
    res.json({ success: true, data: rows[0] });
  } catch (e: any) { res.json({ success: false, error: e.message }); }
});

router.get('/logs/today', auth, async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query("SELECT * FROM fitness_workout_logs WHERE user_id = $1 AND logged_date = CURRENT_DATE ORDER BY created_at DESC LIMIT 1", [req.user!.userId]);
    res.json({ success: true, data: rows[0] || null });
  } catch (e: any) { res.json({ success: false, error: e.message }); }
});

router.get('/logs/history', auth, async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query('SELECT * FROM fitness_workout_logs WHERE user_id = $1 ORDER BY logged_date DESC LIMIT 60', [req.user!.userId]);
    res.json({ success: true, data: rows });
  } catch (e: any) { res.json({ success: false, error: e.message }); }
});

router.patch('/logs/:id/complete', auth, async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query('UPDATE fitness_workout_logs SET completed_at = NOW(), duration_minutes = $1 WHERE id = $2 AND user_id = $3 RETURNING *', [req.body.duration_minutes, req.params.id, req.user!.userId]);
    res.json({ success: true, data: rows[0] });
  } catch (e: any) { res.json({ success: false, error: e.message }); }
});

router.post('/sets', auth, async (req: Request, res: Response) => {
  const { log_id, exercise_id, exercise_name, weight_lbs, reps } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [setLog] } = await client.query('INSERT INTO fitness_set_logs (log_id, user_id, exercise_id, exercise_name, weight_lbs, reps, is_counted) VALUES ($1,$2,$3,$4,$5,$6,TRUE) RETURNING *', [log_id, req.user!.userId, exercise_id, exercise_name, weight_lbs || 0, reps || 0]);
    const { rows: [stats] } = await client.query('SELECT COALESCE(SUM(weight_lbs * reps), 0) as total_lbs FROM fitness_set_logs WHERE user_id = $1 AND is_counted = TRUE', [req.user!.userId]);
    const totalLbs = parseFloat(stats.total_lbs);
    const milestones = [100000, 500000, 1000000, 5000000, 10000000, 50000000, 100000000, 500000000, 1000000000];
    for (const m of milestones) {
      if (totalLbs >= m) {
        const { rows: existing } = await client.query('SELECT id FROM fitness_milestones WHERE user_id = $1 AND milestone_type = $2', [req.user!.userId, m + '_lbs']);
        if (existing.length === 0) await client.query('INSERT INTO fitness_milestones (user_id, milestone_type, total_lbs_at_achievement) VALUES ($1,$2,$3)', [req.user!.userId, m + '_lbs', totalLbs]);
      }
    }
    await client.query('COMMIT');
    res.json({ success: true, data: setLog, total_lbs: totalLbs });
  } catch (e: any) { await client.query('ROLLBACK'); res.json({ success: false, error: e.message }); }
  finally { client.release(); }
});

router.get('/sets/:log_id', auth, async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query('SELECT * FROM fitness_set_logs WHERE log_id = $1 AND user_id = $2 ORDER BY logged_at', [req.params.log_id, req.user!.userId]);
    res.json({ success: true, data: rows });
  } catch (e: any) { res.json({ success: false, error: e.message }); }
});

router.get('/stats', auth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const [totals, weeklyVolume, workoutCount, streakData, milestones, bodyWeight] = await Promise.all([
      pool.query('SELECT COALESCE(SUM(weight_lbs * reps), 0) as total_lbs_lifted, COALESCE(SUM(reps), 0) as total_reps, COUNT(*) as total_sets FROM fitness_set_logs WHERE user_id = $1 AND is_counted = TRUE', [userId]),
      pool.query("SELECT DATE_TRUNC('week', logged_at) as week, COALESCE(SUM(weight_lbs * reps), 0) as volume FROM fitness_set_logs WHERE user_id = $1 AND is_counted = TRUE AND logged_at >= NOW() - INTERVAL '12 weeks' GROUP BY DATE_TRUNC('week', logged_at) ORDER BY week", [userId]),
      pool.query('SELECT COUNT(*) as count FROM fitness_workout_logs WHERE user_id = $1 AND completed_at IS NOT NULL', [userId]),
      pool.query('SELECT logged_date FROM fitness_workout_logs WHERE user_id = $1 AND completed_at IS NOT NULL ORDER BY logged_date DESC LIMIT 30', [userId]),
      pool.query('SELECT * FROM fitness_milestones WHERE user_id = $1 ORDER BY achieved_at', [userId]),
      pool.query('SELECT * FROM fitness_body_weight_logs WHERE user_id = $1 ORDER BY logged_date DESC LIMIT 90', [userId])
    ]);
    let streak = 0;
    const dates = streakData.rows.map((r: any) => r.logged_date.toISOString().split('T')[0]);
    let checkDate = new Date().toISOString().split('T')[0];
    for (const date of dates) {
      if (date === checkDate) { streak++; const d = new Date(checkDate); d.setDate(d.getDate() - 1); checkDate = d.toISOString().split('T')[0]; } else break;
    }
    res.json({ success: true, data: { total_lbs_lifted: parseFloat(totals.rows[0].total_lbs_lifted), total_reps: parseInt(totals.rows[0].total_reps), total_sets: parseInt(totals.rows[0].total_sets), total_workouts: parseInt(workoutCount.rows[0].count), current_streak: streak, weekly_volume: weeklyVolume.rows, milestones: milestones.rows, body_weight_history: bodyWeight.rows } });
  } catch (e: any) { res.json({ success: false, error: e.message }); }
});

router.get('/prs', auth, async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query('SELECT exercise_name, MAX(weight_lbs) as pr_weight, COUNT(*) as total_sets, MAX(logged_at) as last_logged FROM fitness_set_logs WHERE user_id = $1 AND is_counted = TRUE AND weight_lbs > 0 GROUP BY exercise_name ORDER BY exercise_name', [req.user!.userId]);
    res.json({ success: true, data: rows });
  } catch (e: any) { res.json({ success: false, error: e.message }); }
});

router.get('/prs/:exercise/history', auth, async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query('SELECT sl.weight_lbs, sl.reps, sl.logged_at, wl.logged_date FROM fitness_set_logs sl JOIN fitness_workout_logs wl ON sl.log_id = wl.id WHERE sl.user_id = $1 AND sl.exercise_name = $2 AND sl.is_counted = TRUE ORDER BY sl.logged_at DESC', [req.user!.userId, decodeURIComponent(req.params.exercise)]);
    res.json({ success: true, data: rows });
  } catch (e: any) { res.json({ success: false, error: e.message }); }
});

router.get('/progress/:exercise', auth, async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query("SELECT DATE_TRUNC('day', sl.logged_at) as date, MAX(sl.weight_lbs) as max_weight, SUM(sl.weight_lbs * sl.reps) as volume FROM fitness_set_logs sl WHERE sl.user_id = $1 AND sl.exercise_name = $2 AND sl.is_counted = TRUE GROUP BY DATE_TRUNC('day', sl.logged_at) ORDER BY date", [req.user!.userId, decodeURIComponent(req.params.exercise)]);
    res.json({ success: true, data: rows });
  } catch (e: any) { res.json({ success: false, error: e.message }); }
});

router.post('/bodyweight', auth, async (req: Request, res: Response) => {
  const { weight_lbs, logged_date } = req.body;
  try {
    const { rows } = await pool.query('INSERT INTO fitness_body_weight_logs (user_id, weight_lbs, logged_date) VALUES ($1,$2,$3) ON CONFLICT (user_id, logged_date) DO UPDATE SET weight_lbs = EXCLUDED.weight_lbs RETURNING *', [req.user!.userId, weight_lbs, logged_date || new Date().toISOString().split('T')[0]]);
    res.json({ success: true, data: rows[0] });
  } catch (e: any) { res.json({ success: false, error: e.message }); }
});

router.get('/admin/stats', adminAuth, async (req: Request, res: Response) => {
  try {
    const [platform, topLifters, recentUsers, milestoneCounts] = await Promise.all([
      pool.query('SELECT COALESCE(SUM(weight_lbs * reps), 0) as platform_total_lbs, COALESCE(SUM(reps), 0) as platform_total_reps, COUNT(DISTINCT user_id) as active_users, COUNT(*) as total_sets FROM fitness_set_logs WHERE is_counted = TRUE'),
      pool.query('SELECT u.first_name, u.last_name, u.email, COALESCE(SUM(sl.weight_lbs * sl.reps), 0) as total_lbs, COALESCE(SUM(sl.reps), 0) as total_reps, COUNT(DISTINCT wl.id) as total_workouts FROM fitness_set_logs sl JOIN users u ON sl.user_id = u.id JOIN fitness_workout_logs wl ON sl.log_id = wl.id WHERE sl.is_counted = TRUE GROUP BY u.id, u.first_name, u.last_name, u.email ORDER BY total_lbs DESC LIMIT 20'),
      pool.query('SELECT u.first_name, u.last_name, u.email, fp.created_at, fp.fitness_goal, fp.experience_level FROM fitness_profiles fp JOIN users u ON fp.user_id = u.id ORDER BY fp.created_at DESC LIMIT 20'),
      pool.query('SELECT milestone_type, COUNT(*) as users_achieved FROM fitness_milestones GROUP BY milestone_type ORDER BY milestone_type')
    ]);
    res.json({ success: true, data: { platform: platform.rows[0], top_lifters: topLifters.rows, recent_users: recentUsers.rows, milestone_counts: milestoneCounts.rows } });
  } catch (e: any) { res.json({ success: false, error: e.message }); }
});

export { router as fitnessRouter };
