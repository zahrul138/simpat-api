// routes/warningSettings.js
const express = require('express');
const router = express.Router();
const pool = require('../db');

// ─────────────────────────────────────────────────────────────
// GET /api/warning-settings
// ─────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        id,
        TO_CHAR(start_time, 'HH24:MI') AS start,
        TO_CHAR(end_time,   'HH24:MI') AS end,
        reason,
        enabled
      FROM warning_settings
      ORDER BY start_time
    `);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching warning settings:', error);
    res.status(500).json({ error: 'Failed to fetch warning settings' });
  }
});

// ─────────────────────────────────────────────────────────────
// PUT /api/warning-settings/bulk  ← HARUS sebelum /:id
// ─────────────────────────────────────────────────────────────
router.put('/bulk', async (req, res) => {
  const { settings } = req.body;

  if (!Array.isArray(settings) || settings.length === 0) {
    return res.status(400).json({ error: 'settings array is required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query('DELETE FROM warning_settings');

    for (const s of settings) {
      const { start, end, reason, enabled } = s;
      if (!start || !end || !reason) continue;
      await client.query(
        `INSERT INTO warning_settings (start_time, end_time, reason, enabled)
         VALUES ($1, $2, $3, $4)`,
        [start, end, reason, enabled !== false]
      );
    }

    await client.query('COMMIT');

    const result = await client.query(`
      SELECT 
        id,
        TO_CHAR(start_time, 'HH24:MI') AS start,
        TO_CHAR(end_time,   'HH24:MI') AS end,
        reason,
        enabled
      FROM warning_settings
      ORDER BY start_time
    `);

    res.json({
      success: true,
      message: 'Settings updated successfully',
      settings: result.rows,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error bulk updating warning settings:', error);
    res.status(500).json({ error: 'Failed to update warning settings' });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/warning-settings/:id
// ─────────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(`
      SELECT 
        id,
        TO_CHAR(start_time, 'HH24:MI') AS start,
        TO_CHAR(end_time,   'HH24:MI') AS end,
        reason,
        enabled
      FROM warning_settings
      WHERE id = $1
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Warning setting not found' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching warning setting:', error);
    res.status(500).json({ error: 'Failed to fetch warning setting' });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/warning-settings
// ─────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { start, end, reason, enabled = true } = req.body;

    if (!start || !end || !reason) {
      return res.status(400).json({ error: 'start, end, and reason are required' });
    }

    const result = await pool.query(`
      INSERT INTO warning_settings (start_time, end_time, reason, enabled)
      VALUES ($1, $2, $3, $4)
      RETURNING 
        id,
        TO_CHAR(start_time, 'HH24:MI') AS start,
        TO_CHAR(end_time,   'HH24:MI') AS end,
        reason,
        enabled
    `, [start, end, reason, enabled]);

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error creating warning setting:', error);
    res.status(500).json({ error: 'Failed to create warning setting' });
  }
});

// ─────────────────────────────────────────────────────────────
// PATCH /api/warning-settings/:id
// ─────────────────────────────────────────────────────────────
router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { start, end, reason, enabled } = req.body;

    const updates = [];
    const values = [];
    let paramCount = 1;

    if (start !== undefined)   { updates.push(`start_time = $${paramCount++}`); values.push(start); }
    if (end !== undefined)     { updates.push(`end_time   = $${paramCount++}`); values.push(end); }
    if (reason !== undefined)  { updates.push(`reason     = $${paramCount++}`); values.push(reason); }
    if (enabled !== undefined) { updates.push(`enabled    = $${paramCount++}`); values.push(enabled); }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    updates.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id);

    const result = await pool.query(`
      UPDATE warning_settings
      SET ${updates.join(', ')}
      WHERE id = $${paramCount}
      RETURNING 
        id,
        TO_CHAR(start_time, 'HH24:MI') AS start,
        TO_CHAR(end_time,   'HH24:MI') AS end,
        reason,
        enabled
    `, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Warning setting not found' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating warning setting:', error);
    res.status(500).json({ error: 'Failed to update warning setting' });
  }
});

// ─────────────────────────────────────────────────────────────
// DELETE /api/warning-settings/:id
// ─────────────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `DELETE FROM warning_settings WHERE id = $1 RETURNING id`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Warning setting not found' });
    }
    res.json({ success: true, message: 'Warning setting deleted' });
  } catch (error) {
    console.error('Error deleting warning setting:', error);
    res.status(500).json({ error: 'Failed to delete warning setting' });
  }
});

module.exports = router;