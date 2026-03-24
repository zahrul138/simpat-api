const jwt = require('jsonwebtoken');
const pool = require('../db');

module.exports = function auth(required = true) {
  return async (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;

    if (!token) {
      if (!required) return next();
      return res.status(401).json({ error: 'Unauthorized' });
    }

    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch (e) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    try {
      const { rows } = await pool.query(
        'SELECT is_active FROM employees WHERE id = $1 LIMIT 1',
        [payload.id]
      );
      if (!rows[0] || !rows[0].is_active) {
        return res.status(401).json({ error: 'Akun tidak aktif' });
      }
    } catch (e) {
      console.error('[auth middleware] DB check error:', e);
      return res.status(500).json({ error: 'Server error' });
    }

    req.user = payload;
    next();
  };
};