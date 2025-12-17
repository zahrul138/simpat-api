const express = require('express');
const router = express.Router();
const db = require('../db');

// GET all vendor placements
router.get('/', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT 
        id,
        placement_name,
        length_cm,
        width_cm,
        height_cm,
        is_active,
        created_by,
        TO_CHAR(created_at, 'DD/MM/YYYY HH24:MI') as created_at_formatted,
        TO_CHAR(updated_at, 'DD/MM/YYYY HH24:MI') as updated_at_formatted
      FROM vendor_placement 
      ORDER BY created_at DESC
    `);
    
    res.json({
      success: true,
      data: result.rows,
      count: result.rowCount
    });
  } catch (error) {
    console.error('Error fetching vendor placements:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch vendor placements',
      error: error.message
    });
  }
});

// GET single vendor placement by ID
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      `SELECT * FROM vendor_placement WHERE id = $1`,
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Vendor placement not found'
      });
    }
    
    res.json({
      success: true,
      data: result.rows[0]
    });
  } catch (error) {
    console.error('Error fetching vendor placement:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch vendor placement',
      error: error.message
    });
  }
});

// POST create new vendor placement
router.post('/', async (req, res) => {
  try {
    const {
      placement_name,
      length_cm,
      width_cm,
      height_cm,
      is_active = true,
      created_by
    } = req.body;

    // Validasi input
    if (!placement_name || !length_cm || !width_cm || !height_cm) {
      return res.status(400).json({
        success: false,
        message: 'Placement name and dimensions (length, width, height) are required'
      });
    }

    // Validasi numeric
    if (isNaN(parseFloat(length_cm)) || isNaN(parseFloat(width_cm)) || isNaN(parseFloat(height_cm))) {
      return res.status(400).json({
        success: false,
        message: 'Dimensions must be numeric values'
      });
    }

    // Validasi positive values
    if (parseFloat(length_cm) <= 0 || parseFloat(width_cm) <= 0 || parseFloat(height_cm) <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Dimensions must be greater than 0'
      });
    }

    // Cek duplikasi placement name
    const duplicateCheck = await db.query(
      `SELECT id FROM vendor_placement WHERE LOWER(placement_name) = LOWER($1)`,
      [placement_name]
    );

    if (duplicateCheck.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'Placement name already exists'
      });
    }

    // Insert data
    const result = await db.query(
      `INSERT INTO vendor_placement (
        placement_name,
        length_cm,
        width_cm,
        height_cm,
        is_active,
        created_by
      ) VALUES ($1, $2, $3, $4, $5, $6) 
      RETURNING *`,
      [
        placement_name.trim(),
        parseFloat(length_cm),
        parseFloat(width_cm),
        parseFloat(height_cm),
        is_active,
        created_by || 'System'
      ]
    );

    res.status(201).json({
      success: true,
      message: 'Vendor placement created successfully',
      data: result.rows[0]
    });
  } catch (error) {
    console.error('Error creating vendor placement:', error);
    
    // Handle PostgreSQL errors
    if (error.code === '23505') { // unique violation
      return res.status(409).json({
        success: false,
        message: 'Placement name already exists'
      });
    } else if (error.code === '23514') { // check violation
      return res.status(400).json({
        success: false,
        message: 'Invalid dimension values (must be positive)'
      });
    }
    
    res.status(500).json({
      success: false,
      message: 'Failed to create vendor placement',
      error: error.message
    });
  }
});

// PUT update vendor placement
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      placement_name,
      length_cm,
      width_cm,
      height_cm,
      is_active,
      updated_by
    } = req.body;

    // Cek apakah data exist
    const checkExist = await db.query(
      `SELECT id FROM vendor_placement WHERE id = $1`,
      [id]
    );

    if (checkExist.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Vendor placement not found'
      });
    }

    // Update data
    const result = await db.query(
      `UPDATE vendor_placement SET
        placement_name = COALESCE($1, placement_name),
        length_cm = COALESCE($2::DECIMAL, length_cm),
        width_cm = COALESCE($3::DECIMAL, width_cm),
        height_cm = COALESCE($4::DECIMAL, height_cm),
        is_active = COALESCE($5, is_active),
        total_parts = COALESCE($6, total_parts), 
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $6
      RETURNING *`,
      [
        placement_name?.trim(),
        length_cm ? parseFloat(length_cm) : null,
        width_cm ? parseFloat(width_cm) : null,
        height_cm ? parseFloat(height_cm) : null,
        is_active,
        req.body.total_parts,
        id
      ]
    );

    res.json({
      success: true,
      message: 'Vendor placement updated successfully',
      data: result.rows[0]
    });
  } catch (error) {
    console.error('Error updating vendor placement:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update vendor placement',
      error: error.message
    });
  }
});

// DELETE vendor placement (soft delete)
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const result = await db.query(
      `UPDATE vendor_placement SET 
        is_active = false,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING id, placement_name`,
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: 'Vendor placement not found'
      });
    }

    res.json({
      success: true,
      message: `Vendor placement "${result.rows[0].placement_name}" deactivated successfully`
    });
  } catch (error) {
    console.error('Error deactivating vendor placement:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to deactivate vendor placement',
      error: error.message
    });
  }
});

router.get('/search/filter', async (req, res) => {
  try {
    const { 
      name, 
      is_active = true
    } = req.query;

    let query = `
      SELECT 
        id,
        placement_name,
        length_cm,
        width_cm,
        height_cm,
        is_active,
        created_by,
        TO_CHAR(created_at, 'DD/MM/YYYY HH24:MI') as created_at
      FROM vendor_placement 
      WHERE is_active = $1
    `;
    
    const params = [is_active];
    let paramCount = 2;

    if (name) {
      query += ` AND placement_name ILIKE $${paramCount}`;
      params.push(`%${name}%`);
      paramCount++;
    }

    query += ` ORDER BY placement_name`;

    const result = await db.query(query, params);
    
    res.json({
      success: true,
      data: result.rows,
      count: result.rowCount
    });
  } catch (error) {
    console.error('Error filtering vendor placements:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to filter vendor placements',
      error: error.message
    });
  }
});

router.delete('/permanent/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const checkExist = await db.query(
      `SELECT id, placement_name FROM vendor_placement WHERE id = $1`,
      [id]
    );

    if (checkExist.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Vendor placement not found'
      });
    }

    const result = await db.query(
      `DELETE FROM vendor_placement WHERE id = $1 RETURNING id, placement_name`,
      [id]
    );

    res.json({
      success: true,
      message: `Vendor placement "${result.rows[0].placement_name}" deleted successfully`
    });
  } catch (error) {
    console.error('Error deleting vendor placement permanently:', error);
    
    if (error.code === '23503') {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete placement because it is referenced by other records'
      });
    }
    
    res.status(500).json({
      success: false,
      message: 'Failed to delete vendor placement',
      error: error.message
    });
  }
});

// PUT /api/vendors/sync-total-parts - Sync total_parts for all vendors
router.put("/sync-total-parts", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Reset semua total_parts ke 0
    await client.query(`
      UPDATE vendor_detail 
      SET total_parts = 0,
          updated_at = CURRENT_TIMESTAMP
    `);

    // Hitung ulang total_parts dari kanban_master
    const updateQuery = `
      UPDATE vendor_detail vd
      SET total_parts = (
        SELECT COUNT(*) 
        FROM kanban_master km 
        WHERE km.vendor_id = vd.id
          AND km.is_active = true
      ),
      updated_at = CURRENT_TIMESTAMP
      WHERE EXISTS (
        SELECT 1 FROM kanban_master km 
        WHERE km.vendor_id = vd.id
      )
    `;

    await client.query(updateQuery);

    await client.query("COMMIT");

    // Get updated data
    const vendorsQuery = await client.query(`
      SELECT id, vendor_name, total_parts 
      FROM vendor_detail 
      ORDER BY vendor_name
    `);

    res.json({
      success: true,
      message: "Total parts synchronized successfully",
      data: vendorsQuery.rows
    });

  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error syncing total parts:", error);
    res.status(500).json({
      success: false,
      message: "Failed to sync total parts",
      error: error.message
    });
  } finally {
    client.release();
  }
});

module.exports = router;
