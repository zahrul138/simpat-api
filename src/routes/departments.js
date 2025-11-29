const express = require('express');
const pool = require('../db');
const auth = require('../middleware/auth');

const router = express.Router();

router.get('/', auth(), async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, dept_code, dept_name, dept_app FROM departments WHERE is_active = TRUE ORDER BY dept_code'
  );
  res.json(rows);
});

module.exports = router;
