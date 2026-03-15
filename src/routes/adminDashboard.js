// routes/adminDashboard.js
const express = require('express');
const pool    = require('../db');
const auth    = require('../middleware/auth');
const { getOnlineByDept, getOnlineUsers } = require('./activeSessions');

const router = express.Router();

// GET /api/admin-dashboard/stats
router.get('/stats', auth(), async (req, res) => {
  try {
    const [userStats, feedbackStats, recentActivity, recentFeedback] =
      await Promise.all([

        pool.query(`
          SELECT
            COUNT(*)                                   AS total,
            COUNT(*) FILTER (WHERE is_active = true)   AS active,
            COUNT(*) FILTER (WHERE is_active = false)  AS inactive,
            COUNT(*) FILTER (WHERE emp_role = 'Admin') AS admin_count,
            COUNT(*) FILTER (WHERE emp_role = 'User')  AS user_count
          FROM employees
        `),

        pool.query(`
          SELECT
            COUNT(*)                                        AS total,
            COUNT(*) FILTER (WHERE status = 'New')         AS new_count,
            COUNT(*) FILTER (WHERE status = 'In Progress') AS in_progress,
            COUNT(*) FILTER (WHERE status = 'Complete')    AS complete
          FROM user_feedbacks
        `),

        pool.query(`
          SELECT id, emp_name, action, target_name, description, created_at
          FROM activity_logs
          ORDER BY created_at DESC LIMIT 8
        `).catch(() => ({ rows: [] })),

        pool.query(`
          SELECT id, emp_name, department, problem_location, status, submitted_at
          FROM user_feedbacks
          ORDER BY submitted_at DESC LIMIT 5
        `).catch(() => ({ rows: [] })),
      ]);

    const u = userStats.rows[0];
    const f = feedbackStats.rows[0];

    res.json({
      success: true,
      users: {
        total:      parseInt(u.total),
        active:     parseInt(u.active),
        inactive:   parseInt(u.inactive),
        adminCount: parseInt(u.admin_count),
        userCount:  parseInt(u.user_count),
      },
      feedback: {
        total:      parseInt(f.total),
        newCount:   parseInt(f.new_count),
        inProgress: parseInt(f.in_progress),
        complete:   parseInt(f.complete),
      },
      onlineByDept:   getOnlineByDept(),
      onlineUsers:    getOnlineUsers(),  
      recentActivity: recentActivity.rows,
      recentFeedback: recentFeedback.rows,
    });
  } catch (e) {
    console.error('[adminDashboard]', e);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

module.exports = router;