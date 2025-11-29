const express = require('express');
const jwt = require('jsonwebtoken');
const pool = require('../db');

const router = express.Router();

/**
 * POST /auth/login
 * body: { username, password }
 */
router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });

  try {
    const q = `
      SELECT e.id, e.emp_id, e.emp_name, e.username, e.user_password, e.emp_role,
             e.dept_id, d.dept_code, d.dept_name, d.dept_app
      FROM employees e
      LEFT JOIN departments d ON d.id = e.dept_id
      WHERE e.username = $1
      LIMIT 1
    `;
    const { rows } = await pool.query(q, [username]);
    const user = rows[0];

    if (!user || user.user_password !== password) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const payload = {
      id: user.id,
      emp_name: user.emp_name,
      username: user.username,
      role: user.emp_role,       
      dept_id: user.dept_id,
      dept_code: user.dept_code, 
      dept_app: user.dept_app    
    };

    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '8h' });
    res.json({ token, user: payload });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
