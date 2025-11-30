// routes/warningSettings.js
const express = require('express');
const router = express.Router();
const pool = require('../db'); // GANTI: dari '../config/database' menjadi '../db'

// GET all warning settings
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        id,
        TO_CHAR(start_time, 'HH24:MI') as start,
        TO_CHAR(end_time, 'HH24:MI') as end,
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

// GET single warning setting
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(`
      SELECT 
        id,
        TO_CHAR(start_time, 'HH24:MI') as start,
        TO_CHAR(end_time, 'HH24:MI') as end,
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

// CREATE new warning setting
router.post('/', async (req, res) => {
  try {
    const { start, end, reason, enabled = true } = req.body;
    
    const result = await pool.query(`
      INSERT INTO warning_settings (start_time, end_time, reason, enabled)
      VALUES ($1, $2, $3, $4)
      RETURNING 
        id,
        TO_CHAR(start_time, 'HH24:MI') as start,
        TO_CHAR(end_time, 'HH24:MI') as end,
        reason,
        enabled
    `, [start, end, reason, enabled]);
    
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error creating warning setting:', error);
    res.status(500).json({ error: 'Failed to create warning setting' });
  }
});

// UPDATE warning setting
router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { start, end, reason, enabled } = req.body;
    
    // Build dynamic update query
    const updates = [];
    const values = [];
    let paramCount = 1;
    
    if (start !== undefined) {
      updates.push(`start_time = $${paramCount}`);
      values.push(start);
      paramCount++;
    }
    
    if (end !== undefined) {
      updates.push(`end_time = $${paramCount}`);
      values.push(end);
      paramCount++;
    }
    
    if (reason !== undefined) {
      updates.push(`reason = $${paramCount}`);
      values.push(reason);
      paramCount++;
    }
    
    if (enabled !== undefined) {
      updates.push(`enabled = $${paramCount}`);
      values.push(enabled);
      paramCount++;
    }
    
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
        TO_CHAR(start_time, 'HH24:MI') as start,
        TO_CHAR(end_time, 'HH24:MI') as end,
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

// DELETE warning setting
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await pool.query(`
      DELETE FROM warning_settings 
      WHERE id = $1
      RETURNING id
    `, [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Warning setting not found' });
    }
    
    res.json({ success: true, message: 'Warning setting deleted' });
  } catch (error) {
    console.error('Error deleting warning setting:', error);
    res.status(500).json({ error: 'Failed to delete warning setting' });
  }
});

// BULK UPDATE all warning settings
router.put('/bulk', async (req, res) => {
  try {
    const { settings } = req.body;
    
    // Delete all existing settings
    await pool.query('DELETE FROM warning_settings');
    
    // Insert new settings
    for (const setting of settings) {
      await pool.query(`
        INSERT INTO warning_settings (start_time, end_time, reason, enabled)
        VALUES ($1, $2, $3, $4)
      `, [setting.start, setting.end, setting.reason, setting.enabled]);
    }
    
    // Return updated list
    const result = await pool.query(`
      SELECT 
        id,
        TO_CHAR(start_time, 'HH24:MI') as start,
        TO_CHAR(end_time, 'HH24:MI') as end,
        reason,
        enabled
      FROM warning_settings 
      ORDER BY start_time
    `);
    
    res.json({ 
      success: true, 
      message: 'Settings updated successfully',
      settings: result.rows 
    });
  } catch (error) {
    console.error('Error bulk updating warning settings:', error);
    res.status(500).json({ error: 'Failed to update warning settings' });
  }
});

module.exports = router;