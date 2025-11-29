const express = require('express');
const pool = require('../db');
const auth = require('../middleware/auth');

const router = express.Router();

/** utils */
const getDeptIdByCode = async (client, deptCode) => {
  const { rows } = await client.query('SELECT id FROM departments WHERE dept_code = $1 LIMIT 1', [deptCode]);
  if (!rows[0]) throw new Error(`Invalid department code: ${deptCode}`);
  return rows[0].id;
};
const boolFromStatus = (status) => String(status || 'Active').toLowerCase() === 'active';
const pickCreatorName = (createdByFromBody, reqUser) =>
  (createdByFromBody && String(createdByFromBody).trim()) ||
  reqUser?.emp_name ||
  reqUser?.name ||
  'SYSTEM';

/**
 * GET /users
 * list users
 */
router.get('/', auth(), async (req, res) => {
  try {
    const q = `
      SELECT e.id, e.emp_id, e.emp_name, e.username, e.user_password,
             e.emp_role, e.is_active, e.created_at, e.created_by,
             d.dept_code, d.dept_app
      FROM employees e
      LEFT JOIN departments d ON d.id = e.dept_id
      ORDER BY e.id DESC
    `;
    const { rows } = await pool.query(q);
    const formatted = rows.map(r => ({
      id: r.id,
      idCard: r.emp_id,
      name: r.emp_name,
      username: r.username,
      password: r.user_password,                 
      department: r.dept_code,                  
      role: r.emp_role,
      status: r.is_active ? 'Active' : 'Inactive',
      dept_app: r.dept_app,
      createdBy: r.created_by || 'SYSTEM',       
      createdDate: r.created_at                  
    }));
    res.json(formatted);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /users/:id
 * detail user
 */
router.get('/:id', auth(), async (req, res) => {
  const { id } = req.params;
  try {
    const q = `
      SELECT e.*, d.dept_code, d.dept_app
      FROM employees e
      LEFT JOIN departments d ON d.id = e.dept_id
      WHERE e.id = $1
    `;
    const { rows } = await pool.query(q, [id]);
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });

    const u = rows[0];
    res.json({
      id: u.id,
      idCard: u.emp_id,
      name: u.emp_name,
      username: u.username,
      password: u.user_password,              
      department: u.dept_code,
      role: u.emp_role,
      status: u.is_active ? 'Active' : 'Inactive',
      dept_app: u.dept_app,
      createdBy: u.created_by || 'SYSTEM',     
      createdDate: u.created_at
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /users
 * single create
 * body: { idCard, name, username, password, department, role?, status?, createdBy? }
 */
router.post('/', auth(), async (req, res) => {
  const { idCard, name, username, password, department, role = 'User', status = 'Active', createdBy } = req.body || {};
  if (!idCard || !name || !username || !password || !department)
    return res.status(400).json({ error: 'Missing fields' });

  // validasi 7 digit utk safety
  if (String(idCard).length !== 7 || /\D/.test(String(idCard))) {
    return res.status(400).json({ error: 'idCard must be exactly 7 digits' });
  }

  try {
    const dept = await pool.query('SELECT id FROM departments WHERE dept_code = $1', [department]);
    if (!dept.rows[0]) return res.status(400).json({ error: 'Invalid department' });

    const creator = pickCreatorName(createdBy, req.user);

    const q = `
      INSERT INTO employees (emp_id, emp_name, dept_id, username, user_password, emp_role, is_active, created_by, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      RETURNING id
    `;
    const { rows } = await pool.query(q, [
      idCard,
      name,
      dept.rows[0].id,
      username,
      password,               
      role,
      boolFromStatus(status),
      creator                  
    ]);
    res.status(201).json({ id: rows[0].id });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'emp_id or username already exists' });
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /users/bulk
 * bulk create
 * body: { users: [{ idCard, name, username, password, department, role?, status?, createdBy? }, ...] }
 */
router.post('/bulk', auth(), async (req, res) => {
  const { users } = req.body || {};
  if (!Array.isArray(users) || users.length === 0) return res.status(400).json({ error: 'No users' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let inserted = 0;
    for (const u of users) {
      const { idCard, name, username, password, department, role = 'User', status = 'Active', createdBy } = u || {};

      // skip jika field penting kosong
      if (!idCard || !name || !username || !password || !department) continue;
      // validasi 7 digit
      if (String(idCard).length !== 7 || /\D/.test(String(idCard))) continue;

      // dapatkan dept id
      let deptId;
      try {
        deptId = await getDeptIdByCode(client, department);
      } catch {
        continue; // skip invalid department
      }

      const creator = pickCreatorName(createdBy, req.user);

      await client.query(
        `INSERT INTO employees (emp_id, emp_name, dept_id, username, user_password, emp_role, is_active, created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT (emp_id) DO NOTHING`,
        [
          idCard,
          name,
          deptId,
          username,
          password,                 
          role,
          boolFromStatus(status),
          creator                   
        ]
      );
      inserted++;
    }

    await client.query('COMMIT');
    res.json({ ok: true, inserted });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

/**
 * PUT /users/:id
 * update partial
 * body boleh kirim sebagian field
 */
router.put('/:id', auth(), async (req, res) => {
  const { id } = req.params;
  const { idCard, name, username, password, department, role, status } = req.body || {};
  try {
    const dept = department
      ? await pool.query('SELECT id FROM departments WHERE dept_code = $1', [department])
      : null;

    // validasi idCard jika dikirim
    if (idCard !== undefined) {
      if (String(idCard).length !== 7 || /\D/.test(String(idCard))) {
        return res.status(400).json({ error: 'idCard must be exactly 7 digits' });
      }
    }

    const q = `
      UPDATE employees
      SET emp_id        = COALESCE($1, emp_id),
          emp_name      = COALESCE($2, emp_name),
          username      = COALESCE($3, username),
          user_password = COALESCE($4, user_password),
          dept_id       = COALESCE($5, dept_id),
          emp_role      = COALESCE($6, emp_role),
          is_active     = COALESCE($7, is_active),
          updated_at    = CURRENT_TIMESTAMP
      WHERE id = $8
      RETURNING id
    `;
    const { rows } = await pool.query(q, [
      idCard ?? null,
      name ?? null,
      username ?? null,
      password ?? null,
      dept ? dept.rows[0]?.id : null,
      role ?? null,
      typeof status === 'string' ? (status === 'Active') : null,
      id
    ]);

    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Duplicate emp_id/username' });
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * DELETE /users/:id
 */
router.delete('/:id', auth(), async (req, res) => {
  const { id } = req.params;
  await pool.query('DELETE FROM employees WHERE id = $1', [id]);
  res.json({ ok: true });
});

module.exports = router;
