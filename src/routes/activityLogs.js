// routes/activityLogs.js
const express = require('express');
const pool    = require('../db');
const auth    = require('../middleware/auth');

const router = express.Router();

// GET /api/activity-logs
router.get('/', auth(), async (req, res) => {
  const { action, emp_name, date_from, date_to, limit = 200 } = req.query;
  try {
    const conditions = [];
    const values     = [];
    let idx = 1;

    if (action)    { conditions.push(`action = $${idx++}`);           values.push(action); }
    if (emp_name)  { conditions.push(`emp_name ILIKE $${idx++}`);     values.push(`%${emp_name}%`); }
    if (date_from) { conditions.push(`created_at >= $${idx++}`);      values.push(date_from); }
    if (date_to)   { conditions.push(`created_at <= $${idx++}`);      values.push(date_to + ' 23:59:59'); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    values.push(parseInt(limit));

    const { rows } = await pool.query(
      `SELECT id, emp_id, emp_name, action, target_id, target_name, description, created_at
       FROM activity_logs ${where}
       ORDER BY created_at DESC LIMIT $${idx}`,
      values
    );
    res.json({ success: true, data: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// POST /api/activity-logs/logout — dipanggil dari frontend saat logout
// Tidak pakai auth() karena token sudah dihapus sebelum request ini selesai
router.post('/logout', async (req, res) => {
  const { empId, empName, description } = req.body || {};
  try {
    await pool.query(
      `INSERT INTO activity_logs (emp_id, emp_name, action, description) VALUES ($1,$2,$3,$4)`,
      [empId || null, empName || 'SYSTEM', 'LOGOUT', description || null]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('[logout log]', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;