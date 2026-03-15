const express = require('express');
const jwt = require('jsonwebtoken');
const pool = require('../db');

const router = express.Router();

const writeLog = async ({ empId, empName, action, description }) => {
  try {
    await pool.query(
      `INSERT INTO activity_logs (emp_id, emp_name, action, description) VALUES ($1,$2,$3,$4)`,
      [empId || null, empName || 'SYSTEM', action, description || null]
    );
  } catch (e) { console.error('[writeLog]', e.message); }
};

router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });

  try {
    const q = `
      SELECT e.id, e.emp_id, e.emp_name, e.username, e.user_password, e.emp_role,
             e.is_active, e.dept_id, d.dept_code, d.dept_name, d.dept_app
      FROM employees e
      LEFT JOIN departments d ON d.id = e.dept_id
      WHERE e.username = $1
      LIMIT 1
    `;
    const { rows } = await pool.query(q, [username]);
    const user = rows[0];

    if (!user || user.user_password !== password) {
      await writeLog({ empName: username, action: 'LOGIN_FAILED', description: `Failed login attempt for username "${username}"` });
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    if (!user.is_active) {
      await writeLog({ empId: user.id, empName: user.emp_name, action: 'LOGIN_FAILED', description: `Login rejected — account "${user.username}" is inactive` });
      return res.status(401).json({ error: 'Account is inactive.' });
    }

    const payload = {
      id: user.id,
      emp_id: user.emp_id,
      emp_name: user.emp_name,
      username: user.username,
      role: user.emp_role,
      dept_id: user.dept_id,
      dept_code: user.dept_code,
      dept_app: user.dept_app
    };

    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '8h' });
    await writeLog({ empId: user.id, empName: user.emp_name, action: 'LOGIN', description: `User "${user.username}" logged in successfully` });
    res.json({ token, user: payload });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/check', async (req, res) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const jwt = require('jsonwebtoken');
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }

  try {
    const { rows } = await pool.query(
      'SELECT is_active FROM employees WHERE id = $1 LIMIT 1',
      [payload.id]
    );
    if (!rows[0] || !rows[0].is_active) {
      return res.status(401).json({ error: 'Account is inactive' });
    }
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;