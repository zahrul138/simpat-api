const express = require("express");
const router = express.Router();
const pool = require("../db");

// GET /api/parts-enquiry-non-id
router.get("/", async (req, res) => {
  try {
    const { status, part_code, date_from, date_to } = req.query;
    
    let query = `
      SELECT 
        pe.id,
        pe.storage_inventory_id,
        pe.label_id,
        pe.part_code,
        pe.part_name,
        pe.model,
        pe.qty_requested,
        pe.remark,
        pe.status,
        pe.requested_by,
        TO_CHAR(pe.requested_at, 'YYYY/MM/DD HH24:MI') as requested_at,
        pe.created_at,
        e.emp_name as requested_by_name
      FROM parts_enquiry_non_id pe
      LEFT JOIN employees e ON e.id = pe.requested_by
      WHERE pe.is_active = true
    `;
    
    const params = [];
    let paramCount = 0;
    
    if (status) {
      paramCount++;
      query += ` AND pe.status = $${paramCount}`;
      params.push(status);
    }
    if (part_code) {
      paramCount++;
      query += ` AND pe.part_code ILIKE $${paramCount}`;
      params.push(`%${part_code}%`);
    }
    if (date_from) {
      paramCount++;
      query += ` AND DATE(pe.requested_at) >= $${paramCount}`;
      params.push(date_from);
    }
    if (date_to) {
      paramCount++;
      query += ` AND DATE(pe.requested_at) <= $${paramCount}`;
      params.push(date_to);
    }
    
    query += ` ORDER BY pe.created_at DESC`;
    
    const { rows } = await pool.query(query, params);
    res.json({ success: true, data: rows });
  } catch (error) {
    console.error("[GET Parts Enquiry] Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/parts-enquiry-non-id
router.post("/", async (req, res) => {
  const client = await pool.connect();
  try {
    const { parts, requested_by_name } = req.body;
    
    if (!parts || !Array.isArray(parts) || parts.length === 0) {
      return res.status(400).json({ success: false, message: "No parts provided" });
    }
    
    await client.query("BEGIN");
    
    let requestedById = null;
    if (requested_by_name) {
      const empResult = await client.query(
        `SELECT id FROM employees WHERE emp_name = $1 LIMIT 1`,
        [requested_by_name]
      );
      if (empResult.rowCount > 0) {
        requestedById = empResult.rows[0].id;
      }
    }
    
    const insertedIds = [];
    
    for (const part of parts) {
      // Insert to parts_enquiry_non_id
      const result = await client.query(
        `INSERT INTO parts_enquiry_non_id (
          storage_inventory_id, label_id, part_code, part_name, model, 
          qty_requested, remark, status, requested_by, requested_at, is_active
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'New', $8, CURRENT_TIMESTAMP, true)
        RETURNING id, part_code, qty_requested`,
        [
          part.storage_inventory_id,
          part.label_id,
          part.part_code,
          part.part_name,
          part.model,
          part.qty_requested,
          part.remark || '',
          requestedById
        ]
      );
      
      insertedIds.push(result.rows[0].id);
      
      const savedPart = result.rows[0];
      
      // Update storage_inventory: M136 System → OutSystem
      await client.query(
        `UPDATE storage_inventory 
         SET status_tab = 'OutSystem', updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND is_active = true`,
        [part.storage_inventory_id]
      );
      
      // Get current stock levels
      const stockQuery = await client.query(
        `SELECT stock_m136, stock_m101 FROM kanban_master 
         WHERE part_code = $1 AND is_active = true`,
        [part.part_code]
      );
      
      let currentM136Stock = 0;
      let currentM101Stock = 0;
      let partId = null;
      
      if (stockQuery.rows.length > 0) {
        currentM136Stock = parseInt(stockQuery.rows[0].stock_m136) || 0;
        currentM101Stock = parseInt(stockQuery.rows[0].stock_m101) || 0;
        
        const partIdQuery = await client.query(
          `SELECT id FROM kanban_master WHERE part_code = $1 AND is_active = true`,
          [part.part_code]
        );
        if (partIdQuery.rows.length > 0) {
          partId = partIdQuery.rows[0].id;
        }
      }
      
      const qty = parseInt(part.qty_requested);
      const newM136Stock = Math.max(0, currentM136Stock - qty);
      const newM101Stock = currentM101Stock + qty;
      
      // Update kanban_master: M136 → M101
      await client.query(
        `UPDATE kanban_master 
         SET stock_m136 = $1, stock_m101 = $2, updated_at = CURRENT_TIMESTAMP
         WHERE part_code = $3 AND is_active = true`,
        [newM136Stock, newM101Stock, part.part_code]
      );
      
      // Create stock_movement: OUT M136
      await client.query(
        `INSERT INTO stock_movements (
          part_id, part_code, part_name, movement_type, stock_level,
          quantity, quantity_before, quantity_after,
          source_type, source_id, source_reference,
          model, remark, moved_by, moved_by_name, moved_at, is_active
        ) VALUES ($1, $2, $3, 'OUT', 'M136', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, CURRENT_TIMESTAMP, true)`,
        [
          partId,
          part.part_code,
          part.part_name,
          qty,
          currentM136Stock,
          newM136Stock,
          'parts_enquiry_non_id',
          result.rows[0].id,
          'Parts Enquiry Non ID Request',
          part.model,
          `${qty} PCS moved from M136 to M101 for Parts Enquiry`,
          requestedById,
          requested_by_name
        ]
      );
      
      // Create stock_movement: IN M101
      await client.query(
        `INSERT INTO stock_movements (
          part_id, part_code, part_name, movement_type, stock_level,
          quantity, quantity_before, quantity_after,
          source_type, source_id, source_reference,
          model, remark, moved_by, moved_by_name, moved_at, is_active
        ) VALUES ($1, $2, $3, 'IN', 'M101', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, CURRENT_TIMESTAMP, true)`,
        [
          partId,
          part.part_code,
          part.part_name,
          qty,
          currentM101Stock,
          newM101Stock,
          'parts_enquiry_non_id',
          result.rows[0].id,
          'Parts Enquiry Non ID Request',
          part.model,
          `${qty} PCS received from M136`,
          requestedById,
          requested_by_name
        ]
      );
    }
    
    await client.query("COMMIT");
    
    res.json({
      success: true,
      message: `${insertedIds.length} parts enquiry created`,
      data: { ids: insertedIds }
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[POST Parts Enquiry] Error:", error);
    res.status(500).json({ success: false, message: error.message });
  } finally {
    client.release();
  }
});

// PUT /api/parts-enquiry-non-id/:id/remark
router.put("/:id/remark", async (req, res) => {
  try {
    const { id } = req.params;
    const { remark } = req.body;
    
    await pool.query(
      `UPDATE parts_enquiry_non_id 
       SET remark = $1, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $2 AND is_active = true`,
      [remark, id]
    );
    
    res.json({ success: true, message: "Remark updated" });
  } catch (error) {
    console.error("[PUT Parts Enquiry Remark] Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/parts-enquiry-non-id/move-to-waiting
router.post("/move-to-waiting", async (req, res) => {
  try {
    const { ids } = req.body;
    
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, message: "No items selected" });
    }
    
    await pool.query(
      `UPDATE parts_enquiry_non_id 
       SET status = 'Waiting', updated_at = CURRENT_TIMESTAMP 
       WHERE id = ANY($1::int[]) AND is_active = true`,
      [ids]
    );
    
    res.json({ success: true, message: `${ids.length} items moved to Waiting` });
  } catch (error) {
    console.error("[Move to Waiting] Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;