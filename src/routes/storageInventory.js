const express = require("express");
const router = express.Router();
const pool = require("../db");

// GET /api/storage-inventory
router.get("/", async (req, res) => {
  try {
    const { status_tab, date_from, date_to, vendor_name, part_code, part_name } = req.query;

    let query = `
      SELECT 
        id,
        label_id,
        part_id,
        part_code,
        part_name,
        qty,
        vendor_name,
        model,
        stock_level,
        TO_CHAR(schedule_date, 'YYYY-MM-DD') as schedule_date,
        received_by_name,
        TO_CHAR(received_at, 'YYYY-MM-DD HH24:MI:SS') as received_at,
        status_tab,
        status_part
      FROM storage_inventory
      WHERE is_active = true
    `;
    const params = [];
    let paramCount = 0;

    if (status_tab) {
      paramCount++;
      query += ` AND status_tab = $${paramCount}`;
      params.push(status_tab);
    }
    if (date_from) {
      paramCount++;
      query += ` AND DATE(received_at) >= $${paramCount}`;
      params.push(date_from);
    }
    if (date_to) {
      paramCount++;
      query += ` AND DATE(received_at) <= $${paramCount}`;
      params.push(date_to);
    }
    if (vendor_name) {
      paramCount++;
      query += ` AND vendor_name ILIKE $${paramCount}`;
      params.push(`%${vendor_name}%`);
    }
    if (part_code) {
      paramCount++;
      query += ` AND part_code ILIKE $${paramCount}`;
      params.push(`%${part_code}%`);
    }
    if (part_name) {
      paramCount++;
      query += ` AND part_name ILIKE $${paramCount}`;
      params.push(`%${part_name}%`);
    }

    query += ` ORDER BY received_at DESC`;

    const { rows } = await pool.query(query, params);
    res.json({
      success: true,
      data: rows,
    });
  } catch (error) {
    console.error("[GET Storage Inventory] Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch storage inventory",
      error: error.message,
    });
  }
});

// POST /api/storage-inventory/move-to-m136
router.post("/move-to-m136", async (req, res) => {
  const client = await pool.connect();
  try {
    const { ids, moved_by_name } = req.body;
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, message: "No items selected" });
    }

    await client.query("BEGIN");

    // Get items data with additional fields for stock_movements
    const itemsQuery = await client.query(
      `SELECT id, part_id, part_code, part_name, qty, vendor_name, model, 
              TO_CHAR(schedule_date, 'YYYY-MM-DD') as schedule_date
       FROM storage_inventory 
       WHERE id = ANY($1::int[]) AND is_active = true AND status_tab = 'Off System'`,
      [ids]
    );

    if (itemsQuery.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ 
        success: false, 
        message: "No valid items found" 
      });
    }

    // Resolve employee ID
    let movedById = null;
    if (moved_by_name) {
      const empResult = await client.query(
        `SELECT id FROM employees WHERE emp_name = $1 LIMIT 1`,
        [moved_by_name]
      );
      if (empResult.rowCount > 0) {
        movedById = empResult.rows[0].id;
      }
    }

    // Update storage_inventory status_tab to 'M136 System' and set status_part to 'OK'
    const updateResult = await client.query(
      `UPDATE storage_inventory 
       SET status_tab = 'M136 System', 
           status_part = 'OK',
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ANY($1::int[]) AND is_active = true
       RETURNING id, part_code, qty`,
      [ids]
    );

    // Process each item: update stock and create movements
    for (const item of itemsQuery.rows) {
      const partCode = item.part_code;
      const qty = parseInt(item.qty);

      // Get current stock levels
      const stockQuery = await client.query(
        `SELECT stock_off_system, stock_m136 FROM kanban_master 
         WHERE part_code = $1 AND is_active = true`,
        [partCode]
      );

      let currentOffSystemStock = 0;
      let currentM136Stock = 0;
      if (stockQuery.rows.length > 0) {
        currentOffSystemStock = parseInt(stockQuery.rows[0].stock_off_system) || 0;
        currentM136Stock = parseInt(stockQuery.rows[0].stock_m136) || 0;
      }

      const newOffSystemStock = Math.max(0, currentOffSystemStock - qty);
      const newM136Stock = currentM136Stock + qty;

      // Update kanban_master
      await client.query(
        `UPDATE kanban_master 
         SET stock_off_system = $1,
             stock_m136 = $2,
             updated_at = CURRENT_TIMESTAMP
         WHERE part_code = $3 AND is_active = true`,
        [newOffSystemStock, newM136Stock, partCode]
      );

      // Create stock_movement: OUT from Off System
      await client.query(
        `INSERT INTO stock_movements (
          part_id, part_code, part_name, movement_type, stock_level,
          quantity, quantity_before, quantity_after,
          source_type, source_id, source_reference,
          model, production_date, remark,
          moved_by, moved_by_name, moved_at, is_active
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::date, $14, $15, $16, CURRENT_TIMESTAMP, true)`,
        [
          item.part_id,
          partCode,
          item.part_name,
          'OUT',
          'Off System',
          qty,
          currentOffSystemStock,
          newOffSystemStock,
          'storage_inventory',
          item.id,
          'Moved to M136 System',
          item.model,
          item.schedule_date,
          `${qty} PCS moved from Off System to M136 System`,
          movedById,
          moved_by_name
        ]
      );

      // Create stock_movement: IN to M136
      await client.query(
        `INSERT INTO stock_movements (
          part_id, part_code, part_name, movement_type, stock_level,
          quantity, quantity_before, quantity_after,
          source_type, source_id, source_reference,
          model, production_date, remark,
          moved_by, moved_by_name, moved_at, is_active
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::date, $14, $15, $16, CURRENT_TIMESTAMP, true)`,
        [
          item.part_id,
          partCode,
          item.part_name,
          'IN',
          'M136',
          qty,
          currentM136Stock,
          newM136Stock,
          'storage_inventory',
          item.id,
          'From Off System',
          item.model,
          item.schedule_date,
          `${qty} PCS received from Off System`,
          movedById,
          moved_by_name
        ]
      );

      console.log(`[Move to M136] Created stock movements for ${partCode}: OUT Off System, IN M136`);
    }

    await client.query("COMMIT");

    res.json({
      success: true,
      message: `${updateResult.rowCount} item(s) moved to M136 System`,
      updatedIds: updateResult.rows.map(r => r.id)
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[Move to M136] Error:", error);
    res.status(500).json({ 
      success: false, 
      message: "Failed to move items",
      error: error.message 
    });
  } finally {
    client.release();
  }
});

// PUT /api/storage-inventory/:id/update-m136
router.put("/:id/update-m136", async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { qty, status_part, moved_by_name } = req.body;

    if (!qty || !status_part) {
      return res.status(400).json({ 
        success: false, 
        message: "Qty and status_part are required" 
      });
    }

    if (!['OK', 'HOLD'].includes(status_part)) {
      return res.status(400).json({ 
        success: false, 
        message: "status_part must be either 'OK' or 'HOLD'" 
      });
    }

    await client.query("BEGIN");

    const currentItem = await client.query(
      `SELECT si.id, si.part_id, si.part_code, si.part_name, si.qty, si.status_part,
              si.model, si.vendor_name
       FROM storage_inventory si
       WHERE si.id = $1 AND si.is_active = true AND si.status_tab = 'M136 System'`,
      [id]
    );

    if (currentItem.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ 
        success: false, 
        message: "Item not found or not in M136 System" 
      });
    }

    const oldItem = currentItem.rows[0];
    const oldQty = parseInt(oldItem.qty);
    const newQty = parseInt(qty);
    const oldStatus = oldItem.status_part;
    const newStatus = status_part;
    const qtyDiff = newQty - oldQty;
    const partCode = oldItem.part_code;
    const partName = oldItem.part_name;
    const partId = oldItem.part_id;
    const model = oldItem.model;

    let movedById = null;
    if (moved_by_name) {
      const empResult = await client.query(
        `SELECT id FROM employees WHERE emp_name = $1 LIMIT 1`,
        [moved_by_name]
      );
      if (empResult.rowCount > 0) {
        movedById = empResult.rows[0].id;
      }
    }

    await client.query(
      `UPDATE storage_inventory 
       SET qty = $1, 
           status_part = $2,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $3`,
      [newQty, newStatus, id]
    );

    const stockQuery = await client.query(
      `SELECT stock_m136, stock_hold FROM kanban_master 
       WHERE part_code = $1 AND is_active = true`,
      [partCode]
    );
    
    let currentM136Stock = 0;
    let currentHoldStock = 0;
    if (stockQuery.rows.length > 0) {
      currentM136Stock = parseInt(stockQuery.rows[0].stock_m136) || 0;
      currentHoldStock = parseInt(stockQuery.rows[0].stock_hold) || 0;
    }

    if (qtyDiff !== 0 && oldStatus === newStatus) {
      const newM136Stock = currentM136Stock + qtyDiff;
      
      await client.query(
        `UPDATE kanban_master 
         SET stock_m136 = $1,
             updated_at = CURRENT_TIMESTAMP
         WHERE part_code = $2 AND is_active = true`,
        [newM136Stock, partCode]
      );

      const movementType = qtyDiff > 0 ? 'IN' : 'OUT';
      const absQty = Math.abs(qtyDiff);
      
      await client.query(
        `INSERT INTO stock_movements (
          part_id, part_code, part_name, movement_type, stock_level,
          quantity, quantity_before, quantity_after,
          source_type, source_id, source_reference,
          model, remark,
          moved_by, moved_by_name, moved_at, is_active
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, CURRENT_TIMESTAMP, true)`,
        [
          partId, partCode, partName, movementType, 'M136', absQty,
          currentM136Stock, newM136Stock,
          'storage_inventory', id, `Storage Inventory Update`,
          model, `Qty adjusted from ${oldQty} to ${newQty} in M136 System`,
          movedById, moved_by_name
        ]
      );
    }

    if (oldStatus !== newStatus && newStatus === 'HOLD') {
      const newM136Stock = Math.max(0, currentM136Stock - newQty);
      const newHoldStock = currentHoldStock + newQty;
      
      await client.query(
        `UPDATE kanban_master 
         SET stock_m136 = $1,
             stock_hold = $2,
             updated_at = CURRENT_TIMESTAMP
         WHERE part_code = $3 AND is_active = true`,
        [newM136Stock, newHoldStock, partCode]
      );

      await client.query(
        `INSERT INTO stock_movements (
          part_id, part_code, part_name, movement_type, stock_level,
          quantity, quantity_before, quantity_after,
          source_type, source_id, source_reference,
          model, remark,
          moved_by, moved_by_name, moved_at, is_active
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, CURRENT_TIMESTAMP, true)`,
        [
          partId, partCode, partName, 'OUT', 'M136', newQty,
          currentM136Stock, newM136Stock,
          'storage_inventory', id, `Moved to HOLD`,
          model, `Part status changed to HOLD - ${newQty} PCS moved from M136 to HOLD`,
          movedById, moved_by_name
        ]
      );

      await client.query(
        `INSERT INTO stock_movements (
          part_id, part_code, part_name, movement_type, stock_level,
          quantity, quantity_before, quantity_after,
          source_type, source_id, source_reference,
          model, remark,
          moved_by, moved_by_name, moved_at, is_active
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, CURRENT_TIMESTAMP, true)`,
        [
          partId, partCode, partName, 'IN', 'HOLD', newQty,
          currentHoldStock, newHoldStock,
          'storage_inventory', id, `From M136 System`,
          model, `Part status changed to HOLD - ${newQty} PCS received from M136`,
          movedById, moved_by_name
        ]
      );

      console.log(`[Update M136] Status changed to HOLD: ${newQty} PCS moved from M136 to HOLD for ${partCode}`);
    }

    else if (oldStatus !== newStatus && newStatus === 'OK' && oldStatus === 'HOLD') {
      const newHoldStock = Math.max(0, currentHoldStock - newQty);
      const newM136Stock = currentM136Stock + newQty;
      
      await client.query(
        `UPDATE kanban_master 
         SET stock_hold = $1,
             stock_m136 = $2,
             updated_at = CURRENT_TIMESTAMP
         WHERE part_code = $3 AND is_active = true`,
        [newHoldStock, newM136Stock, partCode]
      );

      await client.query(
        `INSERT INTO stock_movements (
          part_id, part_code, part_name, movement_type, stock_level,
          quantity, quantity_before, quantity_after,
          source_type, source_id, source_reference,
          model, remark,
          moved_by, moved_by_name, moved_at, is_active
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, CURRENT_TIMESTAMP, true)`,
        [
          partId, partCode, partName, 'OUT', 'HOLD', newQty,
          currentHoldStock, newHoldStock,
          'storage_inventory', id, `Released to M136`,
          model, `Part status changed to OK - ${newQty} PCS released from HOLD to M136`,
          movedById, moved_by_name
        ]
      );

      await client.query(
        `INSERT INTO stock_movements (
          part_id, part_code, part_name, movement_type, stock_level,
          quantity, quantity_before, quantity_after,
          source_type, source_id, source_reference,
          model, remark,
          moved_by, moved_by_name, moved_at, is_active
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, CURRENT_TIMESTAMP, true)`,
        [
          partId, partCode, partName, 'IN', 'M136', newQty,
          currentM136Stock, newM136Stock,
          'storage_inventory', id, `From HOLD`,
          model, `Part status changed to OK - ${newQty} PCS received from HOLD`,
          movedById, moved_by_name
        ]
      );

      console.log(`[Update M136] Status changed to OK: ${newQty} PCS moved from HOLD to M136 for ${partCode}`);
    }

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "Item updated successfully",
      data: { id, qty: newQty, status_part: newStatus }
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[Update M136 Item] Error:", error);
    res.status(500).json({ 
      success: false, 
      message: "Failed to update item",
      error: error.message 
    });
  } finally {
    client.release();
  }
});

module.exports = router;